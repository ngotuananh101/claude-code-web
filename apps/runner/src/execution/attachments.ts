/**
 * Attachment download and prompt context injection for the runner.
 *
 * When a `run.start` command carries an `attachments` list, the executor downloads
 * each file from the control server into
 * `${runnerHome}/tmp/sessions/${sessionId}/attachments/` and prepends a context
 * block to the prompt so Claude Code knows the files are available to inspect with
 * its native `Read` tool.
 */

import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RunnerAttachmentItem } from "@cc-web/protocol";

export type DownloadedFile = {
  /** The original display name from the attachment metadata. */
  name: string;
  /** Absolute path on the runner filesystem where the file was saved. */
  path: string;
  /** The MIME type declared on the attachment. */
  mimeType: string;
};

export type DownloadOptions = {
  serverUrl: string;
  token: string;
  sessionId: string;
  runnerHome: string;
  attachments: RunnerAttachmentItem[];
};

/**
 * Download each attachment from the control server's attachment endpoint into the
 * session's attachments directory.
 *
 * The download URL is `${serverUrl}/api/runner/attachments/${att.id}`, authenticated
 * with `Authorization: Bearer ${token}`. Each file's display name is sanitized with
 * `path.basename` so a traversal payload in the name cannot escape the target
 * directory.
 */
export async function downloadRunnerAttachments(
  options: DownloadOptions,
): Promise<DownloadedFile[]> {
  const dir = join(options.runnerHome, "tmp/sessions", options.sessionId, "attachments");
  await mkdir(dir, { recursive: true });

  const downloaded: DownloadedFile[] = [];

  for (const att of options.attachments) {
    const safeName = basename(att.name);
    const localPath = join(dir, `${att.id}-${safeName}`);

    const url = `${options.serverUrl}/api/runner/attachments/${att.id}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${options.token}` },
    });

    if (!res.ok) {
      throw new Error(`failed to download attachment ${att.id}: ${res.status} ${res.statusText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer, { mode: 0o600 });

    downloaded.push({
      name: att.name,
      path: localPath,
      mimeType: att.mimeType,
    });
  }

  return downloaded;
}

/**
 * Prepend a context block listing the downloaded attachment files so Claude Code
 * knows to inspect them with its native `Read` tool.
 *
 * When `files` is empty the prompt is returned unchanged.
 */
export function injectAttachmentsContext(prompt: string, files: DownloadedFile[]): string {
  if (files.length === 0) return prompt;

  const listing = files.map((f) => `- ${f.name}: ${f.path} (${f.mimeType})`).join("\n");

  return `[Attached Files]
The user attached the following file(s) for this run. Use your native \`Read\` tool to inspect them (text, code, PDFs, or images/screenshots):
${listing}

User prompt:
${prompt}`;
}
