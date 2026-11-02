import type { RunnerCapabilities, RunnerCommand } from '@cc-web/protocol';

export type SlashCommandItem = {
  name: string;
  description: string;
  argumentHint?: string;
  category: string;
  pluginName?: string;
};

export function getAvailableCommands(runnerCapabilities?: RunnerCapabilities): SlashCommandItem[] {
  const builtinCommands: SlashCommandItem[] = [
    {
      name: 'clear',
      displayName: 'Clear',
      description: 'Clear the conversation',
      category: 'builtin',
    },
    {
      name: 'code-review',
      displayName: 'Code Review',
      description: 'Review code',
      category: 'builtin',
    },
    // Add more builtin commands as needed
  ];

  const runnerCommands: SlashCommandItem[] = runnerCapabilities?.commands?.map((cmd: RunnerCommand) => ({
    name: cmd.name,
    displayName: cmd.displayName || cmd.name,
    description: cmd.description || '',
    category: 'plugin',
    pluginName: cmd.pluginName,
  })) || [];

  return [...builtinCommands, ...runnerCommands];
}

export function filterCommands(commands: SlashCommandItem[], query: string): SlashCommandItem[] {
  if (!query) return commands;

  const normalizedQuery = query.toLowerCase().replace(/^\//, '');

  return commands.filter((cmd) => {
    const nameMatch = cmd.name.toLowerCase().includes(normalizedQuery);
    const displayMatch = cmd.displayName.toLowerCase().includes(normalizedQuery);
    const descriptionMatch = cmd.description.toLowerCase().includes(normalizedQuery);

    return nameMatch || displayMatch || descriptionMatch;
  });
}

export function applyCommandToPrompt(prompt: string, command: SlashCommandItem): { newPrompt: string; cursorPosition: number } {
  const commandText = `/${command.name}`;
  const newPrompt = `${commandText} ${prompt}`.trim();
  const cursorPosition = commandText.length + 1;

  return { newPrompt, cursorPosition };
}
