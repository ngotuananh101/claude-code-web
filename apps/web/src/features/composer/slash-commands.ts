import type { RunnerCapabilities, RunnerCommand } from "@cc-web/protocol";

export type SlashCommandItem = {
  name: string;
  displayName: string;
  description: string;
  argumentHint?: string;
  category: "skill" | "builtin" | "plugin" | "agent";
  pluginName?: string | undefined;
};

export function getAvailableCommands(runnerCapabilities?: RunnerCapabilities): SlashCommandItem[] {
  const builtinCommands: SlashCommandItem[] = [
    {
      name: "clear",
      displayName: "Clear",
      description: "Clear the conversation",
      category: "builtin",
    },
    {
      name: "code-review",
      displayName: "Code Review",
      description: "Review code",
      category: "builtin",
    },
    // Add more builtin commands as needed
  ];

  const runnerCommands: SlashCommandItem[] =
    runnerCapabilities?.commands?.map((cmd: RunnerCommand) => ({
      name: cmd.name,
      displayName: cmd.name,
      description: cmd.description || "",
      ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
      category: cmd.builtin ? ("builtin" as const) : ("plugin" as const),
    })) || [];

  return [...builtinCommands, ...runnerCommands];
}

export function filterCommands(commands: SlashCommandItem[], query: string): SlashCommandItem[] {
  if (!query) return commands;

  const normalizedQuery = query.toLowerCase().replace(/^\//, "");

  return commands.filter((cmd) => {
    const nameMatch = cmd.name.toLowerCase().includes(normalizedQuery);
    const displayMatch = cmd.displayName.toLowerCase().includes(normalizedQuery);
    const descriptionMatch = cmd.description.toLowerCase().includes(normalizedQuery);

    return nameMatch || displayMatch || descriptionMatch;
  });
}

export function detectSlashQuery(
  prompt: string,
  cursor: number,
): { active: boolean; query: string } {
  let start = cursor;
  while (start > 0 && !/\s/.test(prompt[start - 1] ?? "")) start--;
  const word = prompt.slice(start, cursor);
  const atBoundary = start === 0 || /\s/.test(prompt[start - 1] ?? "");
  if (atBoundary && word.startsWith("/") && !word.includes(" ")) {
    return { active: true, query: word.slice(1) };
  }
  return { active: false, query: "" };
}

export function applyCommandToPrompt(
  prompt: string,
  command: SlashCommandItem,
): { newPrompt: string; cursorPosition: number } {
  const commandText = `/${command.name}`;
  const newPrompt = `${commandText} ${prompt}`.trim();
  const cursorPosition = commandText.length + 1;

  return { newPrompt, cursorPosition };
}
