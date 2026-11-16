/** Strip transport wrappers before deciding whether a prompt creates a bubble. */
export function cleanChatPrompt(rawText: string): string {
  if (typeof rawText !== "string" || rawText.trim() === "") return "";
  let text = rawText;
  for (const tag of ["local-command-caveat", "system-reminder", "task-notification"]) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g"), "");
  }
  text = text.replace(
    /<command-name>(.*?)<\/command-name>(?:\s*<command-message>[\s\S]*?<\/command-message>)?(?:\s*<command-args>(.*?)<\/command-args>)?/g,
    (_, name: string, args: string | undefined) => {
      const command = (name ?? "").trim();
      const argumentsText = (args ?? "").trim();
      return argumentsText === "" ? command : `${command} ${argumentsText}`;
    },
  );
  text = text.replace(/<\/?local-command-(stdout|stderr)>/g, "");
  text = text.replace(/<\/?command-(name|message|args)>/g, "");
  if (text.startsWith("[Attached Files]") && text.includes("\n\nUser prompt:\n")) {
    text = text.split("\n\nUser prompt:\n").slice(1).join("\n\nUser prompt:\n");
  }
  return text.trim();
}
