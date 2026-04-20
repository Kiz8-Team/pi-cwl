import Anthropic from "@anthropic-ai/sdk";
import type {
	Tool as AnthropicTool,
	ContentBlockParam,
	MessageCountTokensParams,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import type {
	Api,
	ImageContent,
	Message,
	Model,
	Tool as PiTool,
	TextContent,
	TextSignatureV1,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import OpenAI from "openai";
import type {
	FunctionTool as OpenAIFunctionTool,
	ResponseFunctionCallOutputItemList,
	ResponseInput,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "openai/resources/responses/responses.js";

interface PromptTokenCountInput {
	model: Model<Api>;
	apiKey: string;
	headers?: Record<string, string>;
	systemPrompt?: string;
	messages: Message[];
	tools?: PiTool[];
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

function isAnthropicOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function toAnthropicContentBlocks(content: Array<TextContent | ImageContent>):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	const hasImages = content.some((block) => block.type === "image");
	if (!hasImages) {
		return content.map((block) => (block as { type: "text"; text: string }).text).join("\n");
	}

	const blocks = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: block.text };
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	if (!blocks.some((block) => block.type === "text")) {
		blocks.unshift({ type: "text", text: "(see attached image)" });
	}

	return blocks;
}

function convertMessagesForAnthropic(messages: Message[], supportsImages: boolean): MessageParam[] {
	const params: MessageParam[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({ role: "user", content: msg.content });
				}
				continue;
			}

			const blocks: ContentBlockParam[] = msg.content
				.map((item) => {
					if (item.type === "text") {
						return { type: "text" as const, text: item.text };
					}
					return {
						type: "image" as const,
						source: {
							type: "base64" as const,
							media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
							data: item.data,
						},
					};
				})
				.filter((block) => supportsImages || block.type !== "image")
				.filter((block) => block.type !== "text" || block.text.trim().length > 0);

			if (blocks.length > 0) {
				params.push({ role: "user", content: blocks });
			}
			continue;
		}

		if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({ type: "text", text: block.text });
					continue;
				}
				if (block.type === "thinking") {
					if (block.redacted && block.thinkingSignature) {
						blocks.push({ type: "redacted_thinking", data: block.thinkingSignature });
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push({ type: "text", text: block.thinking });
					} else {
						blocks.push({ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature });
					}
					continue;
				}
				blocks.push({
					type: "tool_use",
					id: block.id,
					name: block.name,
					input: block.arguments ?? {},
				});
			}
			if (blocks.length > 0) {
				params.push({ role: "assistant", content: blocks });
			}
			continue;
		}

		const toolResult = msg as ToolResultMessage;
		const toolResults: ContentBlockParam[] = [
			{
				type: "tool_result",
				tool_use_id: toolResult.toolCallId,
				content: toAnthropicContentBlocks(toolResult.content),
				is_error: toolResult.isError,
			},
		];

		let j = i + 1;
		while (j < messages.length && messages[j].role === "toolResult") {
			const nextMessage = messages[j] as ToolResultMessage;
			toolResults.push({
				type: "tool_result",
				tool_use_id: nextMessage.toolCallId,
				content: toAnthropicContentBlocks(nextMessage.content),
				is_error: nextMessage.isError,
			});
			j++;
		}
		i = j - 1;
		params.push({ role: "user", content: toolResults });
	}

	return params;
}

function convertAnthropicTools(tools: PiTool[] | undefined): AnthropicTool[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters as unknown as AnthropicTool["input_schema"],
	}));
}

function convertMessagesForOpenAI(messages: Message[], supportsImages: boolean): ResponseInput {
	const input: ResponseInput = [];
	let messageIndex = 0;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length === 0) continue;
				input.push({ role: "user", content: [{ type: "input_text", text: msg.content }] });
			} else {
				const content = msg.content
					.map((block) => {
						if (block.type === "text") {
							return { type: "input_text" as const, text: block.text } satisfies ResponseInputText;
						}
						return {
							type: "input_image" as const,
							detail: "auto" as const,
							image_url: `data:${block.mimeType};base64,${block.data}`,
						} satisfies ResponseInputImage;
					})
					.filter((block) => supportsImages || block.type !== "input_image");
				if (content.length === 0) continue;
				input.push({ role: "user", content });
			}
			messageIndex++;
			continue;
		}

		if (msg.role === "assistant") {
			const output: ResponseInput = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						output.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
					}
					continue;
				}
				if (block.type === "text") {
					const parsedSignature = parseTextSignature(block.textSignature);
					const messageId = parsedSignature?.id ? parsedSignature.id.slice(0, 64) : `msg_${messageIndex}`;
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
						status: "completed",
						id: messageId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
					continue;
				}
				const [callId, itemId] = block.id.split("|");
				output.push({
					type: "function_call",
					id: itemId,
					call_id: callId,
					name: block.name,
					arguments: JSON.stringify(block.arguments),
				});
			}
			if (output.length > 0) {
				input.push(...output);
			}
			messageIndex++;
			continue;
		}

		const textResult = msg.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const hasImages = msg.content.some((block) => block.type === "image");
		const hasText = textResult.length > 0;
		const [callId] = msg.toolCallId.split("|");

		let output: string | ResponseFunctionCallOutputItemList;
		if (hasImages && supportsImages) {
			const contentParts: ResponseFunctionCallOutputItemList = [];
			if (hasText) {
				contentParts.push({ type: "input_text", text: textResult });
			}
			for (const block of msg.content) {
				if (block.type === "image") {
					contentParts.push({
						type: "input_image",
						detail: "auto",
						image_url: `data:${block.mimeType};base64,${block.data}`,
					});
				}
			}
			output = contentParts;
		} else {
			output = hasText ? textResult : "(see attached image)";
		}

		input.push({ type: "function_call_output", call_id: callId, output });
		messageIndex++;
	}

	return input;
}

function convertOpenAITools(tools: PiTool[] | undefined): OpenAIFunctionTool[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as Record<string, unknown>,
		strict: false,
	}));
}

async function countOpenAITokens(input: PromptTokenCountInput): Promise<number | undefined> {
	const supportsImages = input.model.input.includes("image");
	const client = new OpenAI({
		apiKey: input.apiKey,
		baseURL: input.model.baseUrl,
		defaultHeaders: input.headers,
	});
	const response = await client.responses.inputTokens.count({
		model: input.model.id,
		instructions: input.systemPrompt,
		input: convertMessagesForOpenAI(input.messages, supportsImages),
		tools: convertOpenAITools(input.tools),
	});
	return response.input_tokens;
}

async function countAnthropicTokens(input: PromptTokenCountInput): Promise<number | undefined> {
	const supportsImages = input.model.input.includes("image");
	const client = isAnthropicOAuthToken(input.apiKey)
		? new Anthropic({
				apiKey: null,
				authToken: input.apiKey,
				baseURL: input.model.baseUrl,
				defaultHeaders: input.headers,
			})
		: new Anthropic({
				apiKey: input.apiKey,
				baseURL: input.model.baseUrl,
				defaultHeaders: input.headers,
			});
	const params: MessageCountTokensParams = {
		model: input.model.id,
		system: input.systemPrompt,
		messages: convertMessagesForAnthropic(input.messages, supportsImages),
		tools: convertAnthropicTools(input.tools),
	};
	const response = await client.messages.countTokens(params);
	return response.input_tokens;
}

export async function countPromptTokens(input: PromptTokenCountInput): Promise<number | undefined> {
	if (!input.apiKey) return undefined;
	if (input.model.provider === "anthropic" || input.model.api === "anthropic-messages") {
		return countAnthropicTokens(input);
	}
	if (
		input.model.provider === "openai" ||
		input.model.provider === "openai-codex" ||
		input.model.api === "openai-responses" ||
		input.model.api === "openai-completions"
	) {
		return countOpenAITokens(input);
	}
	return undefined;
}
