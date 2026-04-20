import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { active } from "../chunk.js";

export const EXPLORATION_FILE_EDIT_DENIED_ERROR =
	"Access denied. File edits are only allowed in action chunks. If you belive you have enough context and are read to make edits - start an action chunk";

export function assertFileMutationAllowed(getMessages?: () => AgentMessage[]): void {
	const messages = getMessages?.();
	if (!messages?.length) return;
	const currentActive = active(messages);
	if (currentActive?.type === "expl") {
		throw new Error(EXPLORATION_FILE_EDIT_DENIED_ERROR);
	}
}
