const CLAIMED_KEY = "claimed";
const TOKEN_HASH_KEY = "tokenHash";

export interface StoredServerConfig {
	claimed: boolean;
	tokenHash: string | null;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export class ServerConfig {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/__yaos/config") {
			return json(await this.readConfig());
		}

			if (request.method === "POST" && url.pathname === "/__yaos/claim") {
				let body: { tokenHash?: string } = {};
				try {
					body = await request.json();
				} catch {
					return json({ error: "invalid json" }, 400);
				}

			if (typeof body.tokenHash !== "string" || !body.tokenHash) {
				return json({ error: "missing tokenHash" }, 400);
			}

			return await this.state.storage.transaction(async (txn) => {
				const claimed = await txn.get<boolean>(CLAIMED_KEY);
				const existingHash = await txn.get<string>(TOKEN_HASH_KEY);
				if (claimed === true && typeof existingHash === "string" && existingHash.length > 0) {
					return json({ error: "already_claimed" }, 403);
				}

				await txn.put(CLAIMED_KEY, true);
				await txn.put(TOKEN_HASH_KEY, body.tokenHash);
				return json({ ok: true });
			});
		}

		return json({ error: "not found" }, 404);
	}

	private async readConfig(): Promise<StoredServerConfig> {
		const claimed = await this.state.storage.get<boolean>(CLAIMED_KEY);
		const tokenHash = await this.state.storage.get<string>(TOKEN_HASH_KEY);
		return {
			claimed: claimed === true && typeof tokenHash === "string" && tokenHash.length > 0,
			tokenHash: typeof tokenHash === "string" && tokenHash.length > 0 ? tokenHash : null,
		};
	}
}

export default ServerConfig;
