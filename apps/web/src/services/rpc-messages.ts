/**
 * Operator-facing copy for the error codes the runner and control server
 * define (§17.3).
 *
 * Shared by `browse-api.ts` and `inspect-api.ts`: both surfaces speak the same
 * code vocabulary, so the translation lives in one place. The lookup happens
 * at call time, after the locale is known, rather than in a module-level map
 * that would freeze the language at import.
 */

import { t } from "@/lib/i18n";

/** The localised copy for a known code, or undefined when the code is unknown. */
export function rpcErrorMessage(code: string): string | undefined {
  switch (code) {
    case "RUNNER_UNAVAILABLE":
    case "RUNNER_NOT_FOUND":
      return t("rpc.runnerUnavailable");
    case "WORKSPACE_NOT_FOUND":
      return t("rpc.workspaceNotFound");
    case "WORKSPACE_AMBIGUOUS":
      return t("rpc.workspaceAmbiguous");
    case "PATH_OUTSIDE_WORKSPACE":
      return t("rpc.pathOutsideWorkspace");
    case "FILE_NOT_FOUND":
      return t("rpc.fileNotFound");
    case "FILE_UNREADABLE":
      return t("rpc.fileUnreadable");
    case "CREDENTIAL_FILE_REFUSED":
      return t("rpc.credentialFileRefused");
    case "NOT_A_DIRECTORY":
      return t("rpc.notADirectory");
    case "NOT_A_FILE":
      return t("rpc.notAFile");
    case "UNSUPPORTED_COMMAND":
      return t("rpc.unsupportedCommand");
    case "DIAGNOSTICS_UNAVAILABLE":
      return t("rpc.diagnosticsUnavailable");
    case "FILE_CONFLICT":
      return t("rpc.fileConflict");
    case "WORKSPACE_BUSY":
      return t("rpc.workspaceBusy");
    case "SYMLINK_REFUSED":
      return t("rpc.symlinkRefused");
    case "FILE_UNSUPPORTED":
      return t("rpc.fileUnsupported");
    case "NO_SNAPSHOT":
      return t("rpc.noSnapshot");
    case "SNAPSHOT_PARTIAL":
      return t("rpc.snapshotPartial");
    case "REVERT_STALE":
      return t("rpc.revertStale");
    case "PLAN_TOO_LARGE":
      return t("rpc.planTooLarge");
    case "SNAPSHOT_INCOMPARABLE":
      return t("rpc.snapshotIncomparable");
    case "FILE_UNWRITABLE":
      return t("rpc.fileUnwritable");
    default:
      return undefined;
  }
}

/**
 * The outcome for a transport or parse failure — there is no code to
 * translate, so the caller gets the generic connectivity message.
 */
export function unreachableOutcome(): { code: "error"; message: string } {
  return { code: "error", message: t("api.unreachable") };
}
