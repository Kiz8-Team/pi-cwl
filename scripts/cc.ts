import { query } from "@anthropic-ai/claude-agent-sdk";

let sessionId: string | undefined;

for await (const message of query({
  prompt: "What tools does the agent have access to?",
  options: {
    allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"], // Listing tools here auto-approves them (no prompting)
    effort: "medium" // Thorough reasoning for complex debugging
  }
})) {
  // Save the session ID to resume later if needed
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
  }

  // Handle the final result
  if (message.type === "result") {
    if (message.subtype === "success") {
      console.log(`Done: ${message.result}`);
    } else if (message.subtype === "error_max_turns") {
      // Agent ran out of turns. Resume with a higher limit.
      console.log(`Hit turn limit. Resume session ${sessionId} to continue.`);
    } else if (message.subtype === "error_max_budget_usd") {
      console.log("Hit budget limit.");
    } else {
      console.log(`Stopped: ${message.subtype}`);
    }
    console.log(`Cost: $${message.total_cost_usd.toFixed(4)}`);
  }
}