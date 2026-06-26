import { CUSTOM_TYPE_DIAGNOSTIC, type PruneDiagnostic } from "./types.js";

type SessionBranchContext = {
	sessionManager: {
		getBranch(): unknown[];
	};
};

type AppendEntryRuntime = {
	appendEntry(customType: string, data?: unknown): unknown;
};

/**
 * Append-only in-session diagnostics for prune attempts.
 *
 * These entries are custom session metadata, not model-facing messages. They
 * exist so /pruner diagnostics can explain what pruning did without adding
 * extra prompt content or changing pruning policy.
 */
export class PruneDiagnosticsStore {
	private entries: PruneDiagnostic[] = [];

	reset(): void {
		this.entries = [];
	}

	getEntries(): PruneDiagnostic[] {
		return this.entries.map((entry) => ({ ...entry }));
	}

	record(
		entry: PruneDiagnostic,
		appendEntry: (customType: string, data?: unknown) => unknown,
	): void {
		this.entries.push({ ...entry });
		try {
			appendEntry(CUSTOM_TYPE_DIAGNOSTIC, entry);
		} catch {
			// Diagnostics must never make pruning fail.
		}
	}

	recordBestEffort(entry: PruneDiagnostic, pi: AppendEntryRuntime): void {
		this.entries.push({ ...entry });
		try {
			pi.appendEntry(CUSTOM_TYPE_DIAGNOSTIC, entry);
		} catch {
			// Diagnostics must never make pruning fail.
		}
	}

	reconstructFromSession(ctx: SessionBranchContext): void {
		this.reset();
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			const record = entry as {
				type?: string;
				customType?: string;
				data?: unknown;
			};
			if (
				record.type === "custom" &&
				record.customType === CUSTOM_TYPE_DIAGNOSTIC
			) {
				const data = record.data as PruneDiagnostic;
				if (data) {
					this.entries.push({ ...data });
				}
			}
		}
	}
}
