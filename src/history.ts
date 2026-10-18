import type { Message } from "./types.ts";

// Adds the user's text to history and returns an undo function for when the model call fails
// before anything else is appended. If history ends in tool results (after max_turns), the text
// joins that message, because two user messages in a row would separate the results from their calls.
// Undo restores the message exactly, including removing anything typed during the run that the
// agent added after it.
export function addUserText(messages: Message[], text: string): () => void {
  const last = messages.at(-1);
  if (last?.role === "user" && Array.isArray(last.content) && last.content.at(-1)?.type === "tool_result") {
    const content = last.content;
    const before = content.length;
    content.push({ type: "text", text });
    return () => {
      // The agent may have replaced the array; trim whichever one the message holds now.
      if (Array.isArray(last.content)) last.content.length = before;
      else last.content = content.slice(0, before);
    };
  }
  const message: Message = { role: "user", content: text };
  messages.push(message);
  return () => {
    const i = messages.lastIndexOf(message);
    if (i >= 0) messages.splice(i, 1);
  };
}
