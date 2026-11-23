(function() {
	// src/sw/assets.ts
	/**
	* Which same-origin runtime assets the service worker serves cache-first from
	* the generation cache. Kept globals-free (primitives in, boolean out — no
	* `Request`/`URL`/worker types) so it imports cleanly into BOTH the WebWorker
	* tsconfig (the worker, src/sw/sw.ts) and the Node scripts tsconfig
	* (scripts/precache-assets.ts), and unit-tests without mocking `Request`.
	*
	* `ASSET_EXTENSION` is the load-bearing shared constant. The build precaches by
	* extension; the SW ALSO serves cache-first by `request.destination` (below), so
	* strictly the served set is a superset of the precached set. That superset is
	* empty in practice — every emitted dist asset carries a recognized extension,
	* so a destination-matched request always also matches by extension and was
	* precached. Importing the ONE extension definition here (instead of duplicating
	* the literal in the build script and diffing it in a test) keeps the two in
	* lockstep on the axis the precache is actually built from; the invariant that
	* closes the gap is "every served asset has a recognized extension", which holds
	* for our own emitted output.
	*/
	var ASSET_EXTENSION = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/;
	var ASSET_DESTINATIONS = /* @__PURE__ */ new Set([
		"script",
		"style",
		"worker",
		"font",
		"image"
	]);
	/**
	* True for a same-origin request the SW serves cache-first within the
	* generation. Match by `request.destination` first (covers the common cases a
	* browser labels) with an extension fallback for anything left as an empty
	* destination.
	*/
	var isCacheableAsset = (destination, pathname, sameOrigin) => sameOrigin && (ASSET_DESTINATIONS.has(destination) || ASSET_EXTENSION.test(pathname));
	/**
	* The fingerprint the build stamps for each precached file and the worker
	* recomputes over the bytes it fetched: hex SHA-256 cut to 64 bits, enough to
	* tell two builds' bytes apart. The one definition both sides use.
	*/
	var contentDigest = async (bytes) => {
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
	};
	// src/data/dbFileSiblings.ts
	/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
	var WRITE_AHEAD_SIDECAR_SUFFIXES = ["-wa0", "-wa1"];
	/**
	* SQLite's own crash-recovery files. These must be removed BEFORE the main
	* `.db`: left beside a fresh database of the same name, SQLite replays them.
	*
	* Wider than what this app produces, deliberately: deletion should clear
	* anything SQLite could replay, whoever wrote it. Restoring is the opposite and
	* uses a narrower whitelist — see `exportSqliteDb`.
	*/
	var SQLITE_JOURNAL_SUFFIXES = [
		"-journal",
		"-wal",
		"-shm"
	];
	[...SQLITE_JOURNAL_SUFFIXES, ...WRITE_AHEAD_SIDECAR_SUFFIXES];
	// src/sw/preview.ts
	/**
	* PR-preview subtree gating. github.io is ONE origin for production
	* (…/knowledge-medium/) AND every PR preview (…/pr-preview/pr-<n>/…). A
	* production/root SW's scope is a PREFIX of every preview path, and since we
	* never `clients.claim()`, the production SW controls a freshly-opened preview
	* page until it reloads — and would otherwise cache the preview's shell +
	* assets under production's OWN keys, poisoning the offline production shell
	* with an unmerged build. So a SW refuses to serve/cache a preview subtree it
	* doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt.
	*
	* Globals-free (a regex + a pure predicate over primitives) so it's unit-tested
	* directly and shared without dragging worker types.
	*/
	var PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//;
	/**
	* True when this SW must NOT touch a request: the request targets a preview
	* subtree that this scope does not own. A preview-scoped SW (its own scope is
	* under /pr-preview/) owns its subtree, so it's never "foreign" to itself.
	*/
	var isForeignPreviewRequest = (ownScopeIsPreview, pathname) => !ownScopeIsPreview && PREVIEW_SUBTREE.test(pathname);
	// src/sw/ledger.ts
	/**
	* Pure decisions over the generation ledger — an install-ordered list of
	* BUILD_IDs (newest last). The worker (src/sw/worker.ts) owns the impure I/O
	* (reading/writing the ledger Response in the meta cache); the retention math
	* lives here so it unit-tests without a cache.
	*
	* Each deploy is an immutable generation with its own km-shell-<id> /
	* km-assets-<id> caches. On activate we keep the most recent `keep`
	* generations (so a tab still on a prior build has a consistent cache to read
	* from) and GC the rest.
	*/
	/** The ids to KEEP: the most recent `keep`, newest-last order preserved. */
	var computeKeepIds = (ledger, keep) => ledger.slice(Math.max(0, ledger.length - keep));
	/**
	* The ids that have aged out of the keep-window and whose caches should be
	* GC'd. Disjoint from computeKeepIds; empty when the ledger fits the window.
	*/
	var computeExpiredIds = (ledger, keep) => ledger.slice(0, Math.max(0, ledger.length - keep));
	/**
	* Normalize a stored ledger value into {ids, updatedAt}. Tolerates the two
	* on-disk shapes: the current {ids, updatedAt} object and the LEGACY bare array
	* (written before timestamps existed) — the latter has no timestamp, which the
	* sweeper reads as "staleness unprovable → never reap". Anything else (null,
	* garbage, non-array ids) degrades to an empty ledger.
	*/
	var normalizeLedger = (raw) => {
		if (Array.isArray(raw)) return {
			ids: raw,
			updatedAt: void 0
		};
		if (raw && typeof raw === "object" && Array.isArray(raw.ids)) {
			const { ids, updatedAt } = raw;
			return {
				ids,
				updatedAt: typeof updatedAt === "number" ? updatedAt : void 0
			};
		}
		return {
			ids: [],
			updatedAt: void 0
		};
	};
	/**
	* Decide which OTHER-scope generation caches a sweep should reclaim. Cache
	* Storage is shared per-origin, so a client accumulates the caches of every PR
	* preview it ever visited; once a PR is merged/closed its preview SW never runs
	* again to GC them, so they leak forever. This sweep (run from any active SW's
	* activate) reclaims them — but ONLY:
	*   - preview scopes (PREVIEW_SUBTREE matches the ledger key's path). Production
	*     is NEVER a preview scope, so it can never be reaped here — the sweep is
	*     structurally incapable of touching prod caches.
	*   - that are STALE: a numeric updatedAt older than staleMs. A legacy
	*     untimestamped ledger (updatedAt undefined) is never reaped — we can't
	*     prove it's abandoned. The current scope's own ledger was just re-stamped
	*     on install, so it's fresh and self-excluded.
	* A generation id still referenced by any KEPT (non-reaped) ledger is spared —
	* two deploys can in principle share a build sha, and we must not delete a cache
	* a live scope depends on. The stale ledger ENTRY is removed regardless (the
	* scope is gone), even when its cache was shared-protected.
	*/
	var computeReapableCaches = ({ ledgers, now, staleMs, selfScopeUrl }) => {
		const isPreviewScope = (scopeUrl) => {
			try {
				return PREVIEW_SUBTREE.test(new URL(scopeUrl).pathname);
			} catch {
				return false;
			}
		};
		const isStale = (l) => typeof l.updatedAt === "number" && now - l.updatedAt > staleMs;
		const reapable = ledgers.filter((l) => l.scopeUrl !== selfScopeUrl && isPreviewScope(l.scopeUrl) && isStale(l));
		const reapableSet = new Set(reapable);
		const keptIds = new Set(ledgers.filter((l) => !reapableSet.has(l)).flatMap((l) => l.ids));
		const reapIds = /* @__PURE__ */ new Set();
		for (const l of reapable) for (const id of l.ids) if (!keptIds.has(id)) reapIds.add(id);
		return {
			reapIds: [...reapIds],
			ledgerScopeUrls: reapable.map((l) => l.scopeUrl)
		};
	};
	// src/utils/idbKeyedStore.ts
	/** Promisify a single `IDBRequest` — resolve on success, reject on error. */
	var promisifyRequest = (request) => new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	/** Resolve when the transaction COMMITS (`oncomplete`), reject on abort/error.
	*  A readwrite write is only durable once the tx commits — `onsuccess` fires
	*  earlier, while the tx is still open — so a caller that navigates/reloads
	*  right after a write can have an un-committed tx rolled back. Handlers are
	*  registered synchronously by the caller (before any await) so an `oncomplete`
	*  that fires before we start awaiting can't be missed. */
	var txCommitted = (transaction) => new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction aborted"));
		transaction.onerror = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction error"));
	});
	/** Record-id prefix for all of an owner's records. The trailing `:` plus
	*  `encodeURIComponent` (which escapes any literal `:` to `%3A`) makes this an
	*  unambiguous, collision-free prefix — `enc("ab"):` is never a prefix of
	*  `enc("abc"):…`, so a `startsWith(prefix)` scan can't match a sibling owner. */
	var idbKeyPrefix = (owner) => `${encodeURIComponent(owner)}:`;
	/** Composite record id. Each segment is encoded so a delimiter inside an id
	*  can't make two distinct `(owner, id)` pairs collide. */
	var idbRecordId = (owner, id) => `${idbKeyPrefix(owner)}${encodeURIComponent(id)}`;
	/**
	* A cached connection to one named DB + one object store, with commit-durable
	* transactions. Each instance owns its own connection handle, so constructing a
	* fresh instance against the same DB models a page reload (a new tab/handle
	* reopening persisted data) — which is exactly how the consumers' tests verify
	* durability.
	*/
	var IdbKeyedStore = class {
		dbName;
		storeName;
		version;
		dbPromise = null;
		constructor(dbName, storeName, version = 1) {
			this.dbName = dbName;
			this.storeName = storeName;
			this.version = version;
		}
		openDb() {
			if (!this.dbPromise) {
				const opened = new Promise((resolve, reject) => {
					const request = indexedDB.open(this.dbName, this.version);
					request.onupgradeneeded = () => {
						const db = request.result;
						if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
					};
					request.onsuccess = () => {
						const db = request.result;
						db.onclose = () => {
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						db.onversionchange = () => {
							db.close();
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						resolve(db);
					};
					request.onerror = () => reject(request.error);
				}).catch((err) => {
					if (this.dbPromise === opened) this.dbPromise = null;
					throw err;
				});
				this.dbPromise = opened;
			}
			return this.dbPromise;
		}
		/**
		* Open a transaction and return its object store plus a commit fence. PRIVATE
		* and footgun-laden by design — the caller must issue its first request
		* synchronously and observe `committed` on EVERY path (await it, or `.catch` it
		* on an error path) or a tx abort surfaces as an unhandled rejection. The public
		* ops ({@link runTransaction}, {@link tx}, {@link scanByPrefix}) wrap exactly
		* that contract so callers never have to.
		*/
		async openTransaction(mode) {
			const transaction = (await this.openDb()).transaction(this.storeName, mode);
			const committed = txCommitted(transaction);
			return {
				store: transaction.objectStore(this.storeName),
				committed
			};
		}
		/**
		* Run `body` against the store within one transaction and resolve on the
		* transaction COMMIT (durability), not a request's `onsuccess`. `body` MUST
		* issue its first request synchronously — it is invoked in the same task that
		* created the tx (see the file header on activeness). If `body` rejects (or the
		* commit fence does), the fence's rejection is observed here so it can't surface
		* as an unhandled rejection, and the original error propagates. Use for cursor
		* scans / read-modify-write; single-request ops use {@link tx}.
		*/
		async runTransaction(mode, body) {
			const { store, committed } = await this.openTransaction(mode);
			try {
				const result = await body(store);
				await committed;
				return result;
			} catch (err) {
				committed.catch(() => {});
				throw err;
			}
		}
		/**
		* Run a single request against the store, resolving on the transaction COMMIT
		* (durability). The common case; multi-request / cursor work uses
		* {@link runTransaction}.
		*/
		async tx(mode, run) {
			return this.runTransaction(mode, (store) => promisifyRequest(run(store)));
		}
		/**
		* Walk every record whose key starts with `prefix` (the per-owner namespace
		* from {@link idbKeyPrefix}), calling `visit` with each matching cursor, in one
		* commit-durable transaction. A value cursor, because `visit` reads
		* `cursor.value`; the `:`-delimited prefix is collision-free across owners, so
		* a scan never reaches a sibling owner. `visit` is synchronous
		* (it runs in the cursor's `onsuccess`, while the tx is active) and may read
		* `cursor.value` or, in a `'readwrite'` scan, `cursor.delete()`; accumulate into
		* a variable it closes over. If `visit` throws, the scan aborts (rolling back a
		* readwrite scan's partial writes) and rejects with that error.
		*/
		async scanByPrefix(mode, prefix, visit) {
			await this.runTransaction(mode, (store) => new Promise((resolve, reject) => {
				const request = store.openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve();
						return;
					}
					try {
						if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) visit(cursor);
						cursor.continue();
					} catch (err) {
						try {
							store.transaction.abort();
						} catch {}
						reject(err);
					}
				};
				request.onerror = () => reject(request.error);
			}));
		}
		/**
		* Delete every record whose key starts with `prefix`, in one commit-durable
		* readwrite transaction. One ranged delete rather than a value cursor: a
		* cursor deserialises every record in the store to test its key, and some
		* stores hold multi-MB records. The range is exactly "starts with": every
		* key from `prefix` up to, excluding, the prefix with its last code unit
		* incremented.
		*/
		async deleteByPrefix(prefix) {
			const last = prefix.charCodeAt(prefix.length - 1);
			if (last === 65535) throw new Error("deleteByPrefix: the prefix has no successor");
			const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1);
			await this.tx("readwrite", (store) => store.delete(IDBKeyRange.bound(prefix, upper, false, true)));
		}
	};
	// src/sw/bootStore.ts
	/**
	* The boot set (shell HTML, first-paint assets, vendor React) in IndexedDB, so
	* a cold launch answers them without touching Cache Storage. On iOS the first
	* Cache Storage call of a service-worker lifetime costs ~600 ms regardless of
	* which cache or how many entries (measured against an IndexedDB open in the
	* same worker: 17 ms); Cache Storage stays the store for everything lazy.
	*
	* Entries are keyed by build id, so a worker only ever serves its own
	* generation's bytes and the activate GC reaps a generation by prefix.
	*/
	var bootKeyPrefix = (buildId) => idbKeyPrefix(buildId);
	var bootKey = (buildId, url) => idbRecordId(buildId, url);
	var idbBootStore = () => {
		const store = new IdbKeyedStore("km-boot", "entries");
		return {
			get: (key) => store.tx("readonly", (s) => s.get(key)),
			putAll: (entries) => store.runTransaction("readwrite", async (s) => {
				for (const [key, entry] of entries) s.put(entry, key);
			}),
			deletePrefix: (prefix) => store.deleteByPrefix(prefix)
		};
	};
	// src/sw/previewDatabases.ts
	var SERVICE_WORKER_META_CACHE = "km-meta";
	var PREVIEW_DATABASE_RECORD_BASENAME = "__km_database__";
	var previewDatabaseRecordInfo = (recordUrl, ledgerBasename) => {
		try {
			const url = new URL(recordUrl);
			const marker = `/${PREVIEW_DATABASE_RECORD_BASENAME}/`;
			const markerIndex = url.pathname.indexOf(marker);
			if (markerIndex < 0) return null;
			const encodedName = url.pathname.slice(markerIndex + marker.length);
			if (!encodedName || encodedName.includes("/")) return null;
			const scopePath = url.pathname.slice(0, markerIndex + 1);
			return {
				scopeUrl: `${`${url.origin}${scopePath}`}${ledgerBasename}`,
				name: decodeURIComponent(encodedName)
			};
		} catch {
			return null;
		}
	};
	// src/sw/worker.ts
	/**
	* The service worker's orchestration — ledger I/O, install precache, activate
	* GC, and fetch routing — as a factory parameterized by its globals
	* (`caches` / `fetch` / origin) instead of reaching for `self`. The worker
	* entry (src/sw/sw.ts) constructs one of these with the real globals + injected
	* build config and wires it to the SW events; tests construct one with an
	* in-memory CacheStorage and a stub fetch and drive install/activate/fetch
	* directly. Keeping this file free of `self` / ServiceWorkerGlobalScope is what
	* makes it importable + unit-testable outside a worker.
	*
	* The versioning model this implements is documented in the sw.ts header.
	*/
	var CACHE_PREFIX = "km-";
	var VENDOR_HOSTS = /* @__PURE__ */ new Set(["esm.sh"]);
	var createServiceWorker = (config, env) => {
		const { buildId, scopeURL, keepGenerations } = config;
		const { caches, fetch, now } = env;
		const SHELL_CACHE = `${CACHE_PREFIX}shell-${buildId}`;
		const ASSET_CACHE = `${CACHE_PREFIX}assets-${buildId}`;
		const VENDOR_CACHE = `${CACHE_PREFIX}vendor`;
		const META_CACHE = SERVICE_WORKER_META_CACHE;
		const toScopeUrl = (p) => new URL(p, scopeURL).toString();
		const resolveManifest = (manifest) => Object.entries(manifest).map(([path, digest]) => [toScopeUrl(path), digest]);
		const SHELL_ENTRIES = resolveManifest(config.precacheShell);
		const PRECACHE_ENTRIES = resolveManifest(config.precacheAssets);
		const PRECACHE_REST_ENTRIES = resolveManifest(config.precacheRestAssets);
		const PRECACHE_ASSETS = PRECACHE_ENTRIES.map(([url]) => url);
		const SHELL_URL = toScopeUrl("./index.html");
		const BOOT_SET = [[SHELL_CACHE, [SHELL_URL]], [ASSET_CACHE, PRECACHE_ASSETS]];
		const BOOT_URLS = new Set(BOOT_SET.flatMap(([, urls]) => urls));
		const deleteGeneration = (id) => [
			caches.delete(`${CACHE_PREFIX}shell-${id}`),
			caches.delete(`${CACHE_PREFIX}assets-${id}`),
			env.bootStore?.deletePrefix(bootKeyPrefix(id)).catch(() => void 0)
		];
		const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname);
		const LEDGER_BASENAME = "__km_generations__";
		const LEDGER_KEY = toScopeUrl(`./${LEDGER_BASENAME}`);
		const readLedgerEntry = async () => {
			try {
				const res = await (await caches.open(META_CACHE)).match(LEDGER_KEY);
				if (!res) return {
					ids: [],
					updatedAt: void 0
				};
				return normalizeLedger(await res.json());
			} catch {
				return {
					ids: [],
					updatedAt: void 0
				};
			}
		};
		const readLedger = async () => (await readLedgerEntry()).ids;
		const writeLedgerEntry = async (entry) => {
			const cache = await caches.open(META_CACHE);
			const nextEntry = {
				...entry,
				updatedAt: now()
			};
			await cache.put(LEDGER_KEY, new Response(JSON.stringify(nextEntry), { headers: { "content-type": "application/json" } }));
		};
		let ledgerMutationChain = Promise.resolve();
		const mutateLedgerEntry = async (mutate) => {
			const run = ledgerMutationChain.then(async () => {
				const entry = await readLedgerEntry();
				await writeLedgerEntry(await mutate(entry));
			});
			ledgerMutationChain = run.catch(() => {});
			await run;
		};
		const recordGeneration = async (id) => {
			await mutateLedgerEntry((entry) => {
				const ids = entry.ids.filter((x) => x !== id);
				ids.push(id);
				return {
					...entry,
					ids
				};
			});
		};
		const forgetGeneration = async (id) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: entry.ids.filter((x) => x !== id)
			}));
		};
		const writeLedger = async (ids) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids
			}));
		};
		const trimLedger = async () => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: computeKeepIds(entry.ids, keepGenerations)
			}));
		};
		let lastTouchAt = 0;
		const maybeTouchOwnLedger = (waitUntil) => {
			if (!OWN_SCOPE_IS_PREVIEW) return;
			const t = now();
			if (t - lastTouchAt <= config.touchIntervalMs) return;
			lastTouchAt = t;
			const touch = (async () => {
				try {
					await mutateLedgerEntry((entry) => entry);
				} catch {}
			})();
			if (waitUntil) waitUntil(touch);
		};
		const install = async () => {
			try {
				await precache();
			} catch (err) {
				await Promise.allSettled(deleteGeneration(buildId));
				await forgetGeneration(buildId).catch(() => {});
				throw err;
			}
		};
		const precache = async () => {
			await recordGeneration(buildId);
			const [shell, assets] = await Promise.all([caches.open(SHELL_CACHE), caches.open(ASSET_CACHE)]);
			const fetchInto = async (cache, url, digest, mode) => {
				const res = await fetch(new Request(url, { cache: mode })).catch(() => null);
				if (!res || !res.ok) return;
				const body = await res.clone().arrayBuffer().catch(() => null);
				if (!body) return;
				if (await contentDigest(body) !== digest) throw new Error(`[sw] ${url} differs from build ${buildId}'s copy; another deploy is being served`);
				await cache.put(url, res).catch(() => {});
			};
			const runPooled = async (entries, limit, task) => {
				let next = 0;
				let failure;
				const worker = async () => {
					while (!failure && next < entries.length) {
						const [url, digest] = entries[next++];
						try {
							await task(url, digest);
						} catch (err) {
							failure ??= { err };
						}
					}
				};
				await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
				if (failure) throw failure.err;
			};
			await runPooled(SHELL_ENTRIES, SHELL_ENTRIES.length, (u, d) => fetchInto(shell, u, d, "reload"));
			await runPooled(PRECACHE_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
			await seedBootStore();
			await runPooled(PRECACHE_REST_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
		};
		const seedBootStore = async () => {
			const store = env.bootStore;
			if (!store) return;
			try {
				for (const [cacheName, urls] of BOOT_SET) {
					const cache = await caches.open(cacheName);
					const entries = [];
					for (const url of urls) {
						const cached = await cache.match(url);
						if (!cached) continue;
						entries.push([bootKey(buildId, url), {
							status: cached.status,
							contentType: cached.headers.get("content-type") ?? "application/octet-stream",
							body: await cached.arrayBuffer()
						}]);
					}
					await store.putAll(entries);
				}
			} catch {}
		};
		const bootStoreFirst = async (url, fallback) => {
			const store = env.bootStore;
			if (store && BOOT_URLS.has(url)) try {
				const entry = await store.get(bootKey(buildId, url));
				if (entry) {
					env.mark?.("bootStoreHitAt");
					return new Response(entry.body, {
						status: entry.status,
						headers: { "content-type": entry.contentType }
					});
				}
			} catch {}
			return fallback();
		};
		const activate = async () => {
			const ledger = await readLedger();
			const keepIds = new Set(computeKeepIds(ledger, keepGenerations));
			const expiredIds = computeExpiredIds(ledger, keepGenerations);
			await Promise.all(expiredIds.flatMap(deleteGeneration));
			if (ledger.length > keepIds.size) try {
				await trimLedger();
			} catch {}
			try {
				await sweepStalePreviewGenerations();
			} catch {}
		};
		const sweepStalePreviewGenerations = async () => {
			const meta = await caches.open(META_CACHE);
			const ledgers = [];
			const databaseRecords = [];
			for (const req of await meta.keys()) {
				if (req.url.endsWith(`/${LEDGER_BASENAME}`)) {
					const res = await meta.match(req);
					if (!res) continue;
					const { ids, updatedAt } = normalizeLedger(await res.json().catch(() => null));
					ledgers.push({
						scopeUrl: req.url,
						ids,
						updatedAt
					});
					continue;
				}
				const recordInfo = previewDatabaseRecordInfo(req.url, LEDGER_BASENAME);
				if (recordInfo) {
					const res = await meta.match(req);
					const raw = res ? await res.json().catch(() => null) : null;
					databaseRecords.push({
						...recordInfo,
						recordUrl: req.url,
						updatedAt: databaseRecordUpdatedAt(raw)
					});
				}
			}
			const sweepNow = now();
			const plan = computeReapableCaches({
				ledgers,
				now: sweepNow,
				staleMs: config.staleScopeMs,
				selfScopeUrl: LEDGER_KEY
			});
			await Promise.all([
				sweepStalePreviewDatabases(meta, {
					ledgerScopeUrls: plan.ledgerScopeUrls,
					knownLedgerScopeUrls: ledgers.map(({ scopeUrl }) => scopeUrl),
					databaseRecords,
					sweepNow,
					staleMs: config.staleScopeMs
				}),
				...plan.reapIds.flatMap(deleteGeneration),
				...plan.ledgerScopeUrls.map((url) => meta.delete(url))
			]);
		};
		const databaseRecordUpdatedAt = (raw) => {
			if (!raw || typeof raw !== "object") return void 0;
			const { updatedAt } = raw;
			return typeof updatedAt === "number" ? updatedAt : void 0;
		};
		const previewIdForScopeUrl = (scopeUrl) => {
			try {
				return new URL(scopeUrl).pathname.match(/\/pr-preview\/(pr-[^/]+)\//)?.[1] ?? null;
			} catch {
				return null;
			}
		};
		const isDatabaseNameForPreviewScope = (databaseName, scopeUrl) => {
			const previewId = previewIdForScopeUrl(scopeUrl);
			if (!previewId) return false;
			const escapedPreviewId = previewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`^kmp-v\\d+~${escapedPreviewId}~[A-Za-z0-9_-]*\\.db$`).test(databaseName);
		};
		const databaseRecordsToSweep = (ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs) => {
			const reapedScopes = new Set(ledgerScopeUrls);
			const knownScopes = new Set(knownLedgerScopeUrls);
			const records = [];
			const seen = /* @__PURE__ */ new Set();
			for (const record of databaseRecords) {
				const orphanedStaleRecord = typeof record.updatedAt === "number" && sweepNow - record.updatedAt > staleMs && !knownScopes.has(record.scopeUrl);
				if (!reapedScopes.has(record.scopeUrl) && !orphanedStaleRecord) continue;
				if (!isDatabaseNameForPreviewScope(record.name, record.scopeUrl)) continue;
				const key = `${record.scopeUrl}\n${record.name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				records.push(record);
			}
			return records;
		};
		const sweepStalePreviewDatabases = async (meta, { ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs }) => {
			const databases = databaseRecordsToSweep(ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs);
			await Promise.all(databases.map(async ({ name, recordUrl }) => {
				try {
					await deleteOpfsSqliteDatabase(name);
					await deleteIndexedDatabase(name).catch(() => {});
				} catch {
					return;
				}
				await meta.delete(recordUrl).catch(() => false);
			}));
		};
		const deleteOpfsSqliteDatabase = async (databaseName) => {
			if (typeof env.storage?.getDirectory !== "function") return;
			const root = await env.storage.getDirectory();
			const journalFailure = (await Promise.allSettled(SQLITE_JOURNAL_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)))).find((result) => result.status === "rejected");
			if (journalFailure) throw journalFailure.reason;
			await removeOpfsEntryIfExists(root, databaseName);
			await Promise.allSettled(WRITE_AHEAD_SIDECAR_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)));
		};
		const removeOpfsEntryIfExists = async (root, name) => {
			try {
				await root.removeEntry(name);
			} catch (err) {
				if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
			}
		};
		const deleteIndexedDatabase = async (databaseName) => {
			const idb = env.indexedDB;
			if (typeof idb?.deleteDatabase !== "function") return;
			if (typeof idb.databases === "function") {
				const existing = await idb.databases().catch(() => null);
				if (existing && !existing.some((db) => db.name === databaseName)) return;
			}
			await new Promise((resolve, reject) => {
				const request = idb.deleteDatabase(databaseName);
				let settled = false;
				const settle = (fn) => {
					if (settled) return;
					settled = true;
					fn();
				};
				request.onsuccess = () => settle(resolve);
				request.onerror = () => settle(() => reject(request.error));
				request.onblocked = () => settle(() => reject(/* @__PURE__ */ new Error(`IndexedDB delete blocked for ${databaseName}`)));
			});
		};
		const isNavigationRequest = (request) => request.mode === "navigate" || request.method === "GET" && (request.headers.get("accept")?.includes("text/html") ?? false);
		const isSameOrigin = (url) => url.origin === env.origin;
		const isVendor = (url) => VENDOR_HOSTS.has(url.hostname);
		const shellCacheFirst = async (request, shellURL) => {
			const cache = await caches.open(SHELL_CACHE);
			env.mark?.("shellCacheOpenedAt");
			const cached = await cache.match(shellURL);
			env.mark?.("shellCacheMatchedAt");
			if (cached) return cached;
			const fresh = await fetch(request);
			if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {});
			return fresh;
		};
		const assetCacheFirst = async (request) => {
			const assets = await caches.open(ASSET_CACHE);
			const cached = await assets.match(request) || await (await caches.open(SHELL_CACHE)).match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) assets.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		const cacheFirst = async (request, cacheName) => {
			const cache = await caches.open(cacheName);
			const cached = await cache.match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		/**
		* Route a GET request. Returns a Response promise for the entry to
		* `respondWith`, or undefined to NOT intercept (let the browser handle it —
		* non-GET, non-http(s), foreign preview subtree, and same-origin non-assets
		* like version.json that must stay fresh).
		*/
		const handleFetch = (request, waitUntil) => {
			if (request.method !== "GET") return void 0;
			const url = new URL(request.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
			maybeTouchOwnLedger(waitUntil);
			if (isForeignPreviewRequest(OWN_SCOPE_IS_PREVIEW, url.pathname)) return void 0;
			if (isNavigationRequest(request) && isSameOrigin(url)) {
				if (url.pathname === scopeURL.pathname || url.href.split(/[?#]/)[0] === SHELL_URL) return bootStoreFirst(SHELL_URL, () => shellCacheFirst(request, SHELL_URL));
				return shellCacheFirst(request, SHELL_URL);
			}
			if (isCacheableAsset(request.destination, url.pathname, isSameOrigin(url))) return bootStoreFirst(request.url, () => assetCacheFirst(request));
			if (isVendor(url)) return cacheFirst(request, VENDOR_CACHE);
		};
		return {
			install,
			activate,
			handleFetch,
			readLedger,
			writeLedger,
			recordGeneration
		};
	};
	// src/sw/sw.ts
	var bootMarks = {
		timeOrigin: performance.timeOrigin,
		evaluatedAt: 0,
		firstNavReceivedAt: 0,
		firstNavAnsweredAt: 0
	};
	var mark = (name) => {
		if (!bootMarks[name]) bootMarks[name] = performance.now();
	};
	var sw = createServiceWorker({
		buildId: "cd7f1165bcbb-d1fd0f89",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"ddfa6541dbbde47b\",\"/knowledge-medium/index.html\":\"ddfa6541dbbde47b\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-h_5lhWE_.js\":\"438700be637a9d9c\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"f15c198ea8b0e47e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CBY1_USW.js\":\"27838e329dd4e2ac\",\"/knowledge-medium/chunks/FacadeVFS-DHQzoazm.js\":\"0d99157a91e388ab\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DfjPPNks.js\":\"bbe4d406e602207a\",\"/knowledge-medium/chunks/MemoryVFS-Ba0W-mEF.js\":\"a7494650b10567a6\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-YSBJ4rbG.js\":\"c1f984b4458bd564\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BPgzsSpW.js\":\"ac3f2fae31f88a8a\",\"/knowledge-medium/chunks/Preview-BgHQJ9gF.js\":\"aa29cb125a28172a\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CpXAc5mZ.js\":\"694be4311f62ca55\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-Bb9KAd2R.js\":\"21a358bfcfe1c312\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B9rB73eR.js\":\"625fba63c6550659\",\"/knowledge-medium/chunks/react-BE6CD30u.js\":\"4ef9cedc47d9e384\",\"/knowledge-medium/chunks/react-BvNyiLA4.js\":\"83be7043b5ab34bd\",\"/knowledge-medium/chunks/react-CH6gBMke.js\":\"66b9b110bf36b8e6\",\"/knowledge-medium/chunks/react-CRb_Smvq.js\":\"11fc3d26915a584b\",\"/knowledge-medium/chunks/react-_IAnBIKe.js\":\"7c2cc0fe73e4b427\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DaKLlP_a.js\":\"7a08c565a581dcd5\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DYt0RDSu.js\":\"966d97bb2a867e35\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DcJ4BbgY.js\":\"a82782313ff0ef8c\",\"/knowledge-medium/chunks/react-gtfFLgdm.js\":\"ca4f8eb427137529\",\"/knowledge-medium/chunks/react-hhaJ3TXS.js\":\"ea6294bfc6e6a589\",\"/knowledge-medium/chunks/server.browser-BYfgMizH.js\":\"0d4670c975310d4e\",\"/knowledge-medium/chunks/textarea-CjH_NIF5.js\":\"bf456ed3af7864f3\",\"/knowledge-medium/chunks/ui-CKbtUkkC.js\":\"b320a6815fab7f2f\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"1ab82679421b5753\",\"/knowledge-medium/src/appUpdate.js\":\"cba57728927a4708\",\"/knowledge-medium/src/appVersion.js\":\"3ff393fa355c447c\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"e9cf8802cd7b2c45\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"ab0ffd988ff5af3e\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"ec05619c55319921\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"e4523e88ec8ccda0\",\"/knowledge-medium/src/components/BlockComponent.js\":\"d1885ebdf57d43fe\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"6e026183adb0bcd3\",\"/knowledge-medium/src/components/BlockEditor.js\":\"6d4aa73935b7788c\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"2d3e654141c168db\",\"/knowledge-medium/src/components/BlockProperties.js\":\"409020e23210ae62\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"0f90552361f04f77\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"2258516f0f50d3d3\",\"/knowledge-medium/src/components/DividerHandle.js\":\"e54cc1c1835d8a55\",\"/knowledge-medium/src/components/DraftEditor.js\":\"839d33a107c3c3cb\",\"/knowledge-medium/src/components/GutterPill.js\":\"50d53136f13aa38b\",\"/knowledge-medium/src/components/Header.js\":\"d84cf00a22d1a963\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"c703b1eade9fbac4\",\"/knowledge-medium/src/components/Login.js\":\"11bfa92610505578\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"b81f435cbb705531\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"6f9c9ab0f7a37896\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"43975e1bb2348300\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1f9740412950ae96\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"bc1b30bb1bd88fd4\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"91479f8feb9991c4\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"6b21d0c871f9e887\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"52e42aa7c4aaff20\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"884a455804d36b58\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"f3639625b32f7715\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"bf21bd7f9fda9bfd\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"308dfe427cc5eb8e\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"c0e0b2c7fece3c38\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"1df8d177a2578b9b\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"8b69fff9d2b34d04\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"6cfa3afeccbce952\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"39fb20dc5b8d9f51\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"4e52238fc62ec5da\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"4489a2dc2b45a547\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"b7067f4e29d5fb49\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"51c12bd89e454274\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"893205c151ab81ef\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"27a9c12e39e9f03f\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"4b6f3b0586e4f92f\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"aa305b9fa1849976\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"180d2ac6aba87e9b\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"709e19c85fe101b6\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"e5007ee721061639\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"63ca7db52a43e189\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"19c76ff7f860ffce\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"931dc037c06aa353\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"ea2dd847903c11c6\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"2f1cab07ac059f48\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"bfc65caf7e006628\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"895897a2eae1d106\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"05fd6b73bc391739\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"f262edce037d32e0\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"edba75e1ef76dfdc\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"3342f1a1b927632c\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f647a2cbdca6744d\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"6fe0b22f8000db17\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c37a3da636dfc8da\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"9761a9e4a864903e\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"25048cad14b2b6dc\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"9502759c90230d38\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"f9c2ecc1e091a26b\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"ad035607b344c5fc\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2f24069af2583978\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"53d92bfb514853b9\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"2b158bd5b3e39895\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"4f25d05dff2ab7f6\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"c0b7a87acc28bd63\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"024e0dbd4af8ed4b\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"290cf926c36677d3\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"791e805b67169903\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"332ac17542795f48\",\"/knowledge-medium/src/components/ui/button.js\":\"7ea7237c9856c19c\",\"/knowledge-medium/src/components/ui/card.js\":\"c8752bb816dfc9e4\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"cbe33cbf678a659e\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"4e2479e3a4971cb8\",\"/knowledge-medium/src/components/ui/command.js\":\"2fac50ea1ce1c683\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"1b8ea152347156f7\",\"/knowledge-medium/src/components/ui/dialog.js\":\"a135854946f363c2\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"3f00221dfdeacb08\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"4ea76f2f42760ffa\",\"/knowledge-medium/src/components/ui/index.js\":\"8fa58db97ecc1ffa\",\"/knowledge-medium/src/components/ui/input.js\":\"5613e885b4d0f5c2\",\"/knowledge-medium/src/components/ui/kbd.js\":\"3928c2ce485dda2b\",\"/knowledge-medium/src/components/ui/label.js\":\"b783d9c4f251e248\",\"/knowledge-medium/src/components/ui/textarea.js\":\"7e38d13ceb3e435c\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"e2d459b17223b30e\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"7ff475140934b029\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"337dc026832cf354\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"1a37257f7f6685a1\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"ec5ad3cffcd9bb5c\",\"/knowledge-medium/src/components/util/error.js\":\"b05ba46e94f5bd65\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"abb77250e7b9769b\",\"/knowledge-medium/src/components/util/suspense.js\":\"b309e22d3edd844a\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0312b84e7360c738\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"d7084a1621d54d49\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"51ea3df2c9df5153\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"ca021824cc70bd0a\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"708e59b74092eb7b\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"52d8356ffa8215d4\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"bf38bd18a418c698\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"810cd884dd93236d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"f73c90f68a3231e0\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"44e6cfcab9d6087f\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"16b9a251d4f117ac\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"dd829be361d50d4d\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"dd137bdd9bf3c28a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"f57696762f9e3018\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"cea1e749471d567b\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"e1b7f3b5b13590f6\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"8dd834334247721b\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"7ca776b9934496e4\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"719170c0e3304cc8\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"a654803f457b57b5\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"9172674f95287226\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"8a6a571a43f2dff8\",\"/knowledge-medium/src/context/block.js\":\"41244dfe143b8d17\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"fa652e44d0f45324\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"1169213166b7bcb6\",\"/knowledge-medium/src/context/repo.js\":\"51afdcb2a504ac2a\",\"/knowledge-medium/src/data/aliasClaim.js\":\"20277cfeae6fbabe\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"188481170685e914\",\"/knowledge-medium/src/data/api/blockData.js\":\"0a89d7297e85328c\",\"/knowledge-medium/src/data/api/blockType.js\":\"d48b28d3633ec1c0\",\"/knowledge-medium/src/data/api/changeScope.js\":\"72848df949cfbbb7\",\"/knowledge-medium/src/data/api/codecs.js\":\"2973b62b66b1d783\",\"/knowledge-medium/src/data/api/derivedData.js\":\"28f7a91cc60e111d\",\"/knowledge-medium/src/data/api/errors.js\":\"93c313ba51fa0844\",\"/knowledge-medium/src/data/api/events.js\":\"d4769a21f7ea0754\",\"/knowledge-medium/src/data/api/handle.js\":\"177cf619c4034dc0\",\"/knowledge-medium/src/data/api/index.js\":\"9fd7e3facc8493fd\",\"/knowledge-medium/src/data/api/mutator.js\":\"4b8a72cc59243393\",\"/knowledge-medium/src/data/api/processor.js\":\"93ef0219339fdfe4\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"c3b9ecf19a475c9c\",\"/knowledge-medium/src/data/api/query.js\":\"4293f2014aa1fa2a\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"5248fc70b9e98df5\",\"/knowledge-medium/src/data/api/schema.js\":\"177cf619c4034dc0\",\"/knowledge-medium/src/data/api/tx.js\":\"177cf619c4034dc0\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"67589333c1ea0276\",\"/knowledge-medium/src/data/api/user.js\":\"364494ff1e7178d3\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"611684006b568992\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"fb83782046c628a1\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"0c7f0a997de5b074\",\"/knowledge-medium/src/data/block.js\":\"31e1764c1690ce50\",\"/knowledge-medium/src/data/blockCache.js\":\"875843525971ce1a\",\"/knowledge-medium/src/data/blockId.js\":\"8d2df60d386c7742\",\"/knowledge-medium/src/data/blockLiveness.js\":\"6190794b016ca5c1\",\"/knowledge-medium/src/data/blockMerge.js\":\"ac88c8a034258ab3\",\"/knowledge-medium/src/data/blockSchema.js\":\"eff127c42e89782d\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"11c97b6166f86ebb\",\"/knowledge-medium/src/data/blockTypes.js\":\"83870493b56a63b6\",\"/knowledge-medium/src/data/childrenView.js\":\"75c262c73cd5f737\",\"/knowledge-medium/src/data/clientContext.js\":\"8b6c734f980b8214\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"a4e737cbbeec99c1\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"1a333ff9870f8f6d\",\"/knowledge-medium/src/data/derivedIds.js\":\"1b522f1ecbfc4f46\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"8501b2405d8a17fd\",\"/knowledge-medium/src/data/facetBridge.js\":\"0958d558918975f4\",\"/knowledge-medium/src/data/facets.js\":\"7f5fef383faf126d\",\"/knowledge-medium/src/data/globalState.js\":\"9679f4331063e350\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"7d04d588ed2ef1b4\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"78139b5e727b7e27\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"e95730bf5a74752d\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"2c6a20797b1b2666\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"2b4685c5093832d7\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"91c0039d07531b50\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"5a31354898c818d8\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"5fa62bf4f7826d2e\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"166dad4d0393c917\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"22be1eab10d54978\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"ace7bf46bed93ee5\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"93091da293c8b055\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"40d255e36529ff58\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"c4ceb18119bc9e8c\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"8164c8fef1218c99\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"b8cd0065fb161ae1\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"fe1328ea299adc15\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"3ac882fcadda2c51\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"6c36afb725cde254\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"4478a8ecd0ae162a\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"e9e26d6a6a939390\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"cc8af65f445b8721\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"3e910efe0e65a01b\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"957e2b746d4a82fb\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e564fc58e8e78bf1\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"dc6065f26bfa3f1c\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"1c40ed77bcd4e75c\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"ab91c47b134c381d\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"ed5d391fa2afc36f\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"50bad60d260fcf24\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"00f6e9b1aa16d82a\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"ef941daeadd9e6f9\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"dad73cf77ab5b05d\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"868b226c948a398e\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"6685d9f48e48ac6a\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"fe5c15be6b76eb89\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0295c621e2445426\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"17a434aaaf90b929\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e16652434036ae1e\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"049366eefb708b0f\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"b77acde79a28ae23\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"e6f196e2da09c61a\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"3894644635bef337\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"db10b9d6cb2a7898\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"61c06d5a05886e48\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"adebd42a1cda0214\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"9b11422dddc2fad6\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"42364890e496d403\",\"/knowledge-medium/src/data/invalidation.js\":\"b535600645e6a33c\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"4ac49d901bf7acbe\",\"/knowledge-medium/src/data/kernelPage.js\":\"5d29539643be2889\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"5be5bee25bf38b41\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"7676c1f2fcbed28f\",\"/knowledge-medium/src/data/localDbStorage.js\":\"454c1b5de55d3e5d\",\"/knowledge-medium/src/data/localDbVfs.js\":\"53bf0d0fcf1011c7\",\"/knowledge-medium/src/data/localSchema.js\":\"c6a80236654bcc22\",\"/knowledge-medium/src/data/maintenance.js\":\"fbe6ed64db303162\",\"/knowledge-medium/src/data/mergeProperties.js\":\"13361bdb283f5ec3\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"9b67448a3727ed73\",\"/knowledge-medium/src/data/migrationsPage.js\":\"66adee5e52d6ff97\",\"/knowledge-medium/src/data/mutators.js\":\"fd37f7d31ca89073\",\"/knowledge-medium/src/data/orderKey.js\":\"ad28acff90ffa050\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"976f871681557d3f\",\"/knowledge-medium/src/data/outlineSurface.js\":\"a934b9ca4593d560\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"5ce2d68ad4e20381\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"20ee778e53435e53\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"a02fdc3c869fede9\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"0ff1ca110ad13a97\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"302642fa544246d4\",\"/knowledge-medium/src/data/properties.js\":\"6a24550e10e2783c\",\"/knowledge-medium/src/data/propertiesPage.js\":\"b7fd3cf74768f710\",\"/knowledge-medium/src/data/propertyChildren.js\":\"e417fe35f2a48f3b\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"998191c297f75de1\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"8c8f27bb98a44884\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"a14d1900229d86d5\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"6e82e9080d81124c\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4333e41b962e2213\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"e10c8274eb8c58ac\",\"/knowledge-medium/src/data/propertySeeds.js\":\"1c401632081942c8\",\"/knowledge-medium/src/data/recentsPage.js\":\"37b2608fe5b369a7\",\"/knowledge-medium/src/data/referenceBlock.js\":\"1695f5d896a60cad\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"d6d93a5124d9ccc9\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"bdb6c700086933ca\",\"/knowledge-medium/src/data/repo.js\":\"e4cf5489b117ba6f\",\"/knowledge-medium/src/data/repoProvider.js\":\"4e49d0f5dc1c10fb\",\"/knowledge-medium/src/data/rowProperty.js\":\"4371fa32ed1afe2e\",\"/knowledge-medium/src/data/searchFilter.js\":\"9bcb4e8f6cd4c378\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"291ac5f2a4500f6d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"ab413717456ab4ae\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"cc20dec1a32dbc79\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"c910b9573f654c59\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"d81e03336d51a84a\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"249730449e2d826c\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"c801ad4e95e3106b\",\"/knowledge-medium/src/data/targets.js\":\"0799112877094935\",\"/knowledge-medium/src/data/typeColors.js\":\"879daf4965888198\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"82dfa0a0ac524045\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"1b8b1f527c72cffa\",\"/knowledge-medium/src/data/typeExtraction.js\":\"9aa1549d452a2ddc\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"9cdc463a557283be\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"6370e05d84dfb7f3\",\"/knowledge-medium/src/data/typeSeeds.js\":\"37545b2f0271e9da\",\"/knowledge-medium/src/data/typeTagger.js\":\"da001bae1f648616\",\"/knowledge-medium/src/data/typedRecords.js\":\"aa066200c63c11e3\",\"/knowledge-medium/src/data/typesPage.js\":\"eb784eec7cd637b3\",\"/knowledge-medium/src/data/userPrefs.js\":\"144924c68ae109d4\",\"/knowledge-medium/src/data/userSchemasService.js\":\"d70c95f49b130746\",\"/knowledge-medium/src/data/userTypesService.js\":\"94ab6dcabcc2963b\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"552783774ca20241\",\"/knowledge-medium/src/data/visibleChildren.js\":\"624064cca81f058d\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"635bac0482760d97\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"36c6f9293663056a\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"e0a8f4dc92d18a19\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"ca2ca03a6fda12f8\",\"/knowledge-medium/src/data/workspaces.js\":\"29dbbcbcf01ae7a1\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"ea5706c2942b0b20\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"d7291b98f5c304c0\",\"/knowledge-medium/src/editor/atTrigger.js\":\"db199e6763210951\",\"/knowledge-medium/src/editor/autocomplete.js\":\"fb1f6b124d2ae3c5\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"74df4ba8efcff343\",\"/knowledge-medium/src/editor/contentFlush.js\":\"f857ae94be3a4160\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"993db71c4e7785e2\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"213cea5f0345d4df\",\"/knowledge-medium/src/editor/insertImage.js\":\"b6fb52ca04ab1e8f\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"636bc7f7b41b2352\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"3264332579dea615\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"5b12e967157d0913\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"0cae6c8f1396e418\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"5c9a0d625e82525e\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"5f2ec8ccacb777ac\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"6d4ae9fd296cda92\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"85bed33408cd6b15\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"3079aef526b834aa\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"5b8765aff51b00ac\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"2a4dbe92c8432ac1\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"0246b82b4310e960\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"09c866175f1c4c16\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"c8d30a186701f103\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"4f9fd1058ae04632\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"feb7eaf5d5102eea\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"f18d527203bf26a0\",\"/knowledge-medium/src/extensions/core.js\":\"817e58bbb9baf6c3\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"23f40400c75b622d\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"ea169e5bfe5bba0d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"6cd4dbb9ac664b96\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"dc7f412eddd91ab9\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"6fabfeeda79534ee\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"008e4e9929aa9926\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"6bc6e94f5986b669\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"ed68f15398ca948d\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"4c98a7325d829fdb\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"d61f1379a1fa2fee\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"f39b383ab5714b52\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"0d21503e9b039da6\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"c4aa7f4303c13881\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"26c6200a7ab9b798\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"ca723fad93ca0a91\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"8cf2178c68a6478c\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"858098539d510895\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"606c9b8db219cc27\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"0f19f97eba7fbd8b\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"ffd5357d833dada8\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"e934da0302cfb729\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"077ca675133d9f73\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"1c17ff7c80503787\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"ca5a8c343a8f5a38\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"74b347eeb73835d6\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"4fba49b9fc7920f3\",\"/knowledge-medium/src/facets/facet.js\":\"81edbff3a78a975c\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"95a9ab98ea9745b0\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"e1df25f5d421bc40\",\"/knowledge-medium/src/facets/togglable.js\":\"436b9c3a0c0674ff\",\"/knowledge-medium/src/facets/variantFacet.js\":\"c16ba5dc28559188\",\"/knowledge-medium/src/facets/verbFacet.js\":\"512e054e9999f66d\",\"/knowledge-medium/src/hooks/block.js\":\"ce1a56c6fa7e6356\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"4ce1d0e90503fa17\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"8bafa464246b07a4\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"95782b0ca2289d91\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"48e11d39e5110e1b\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"02e311b1222c4c0b\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"b0e760c5295b73be\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"9428f2e3f319def0\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"54e16320cc53b33c\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"6fb13c4c3606ca64\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"20cef39e729083d3\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"053428d1cdd9ae08\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"daf1d5fa19bc9ba6\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"8443663f8105afbb\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"1314b0e852f18134\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"9b64c6a7c5259db0\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"db651f6f7be46f17\",\"/knowledge-medium/src/lib/utils.js\":\"8f3f252de950c8cb\",\"/knowledge-medium/src/main.js\":\"b6ce8dba6155eab9\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"619eabb0b62a52e9\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"5ddef1eea0c4f07a\",\"/knowledge-medium/src/markdown/context.js\":\"1a461d5df274f486\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"2cd431a2f4c350be\",\"/knowledge-medium/src/markdown/extensions.js\":\"a5b9fcab92aa7228\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"c7c35f692e73eca4\",\"/knowledge-medium/src/minimal-editor.js\":\"a05c34c3b5173e66\",\"/knowledge-medium/src/paste/armedCut.js\":\"a483c108f5423970\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"35eea789555b4c9f\",\"/knowledge-medium/src/paste/clipboard.js\":\"0c6a88844b2dda81\",\"/knowledge-medium/src/paste/decision.js\":\"92b5f36e493b81b9\",\"/knowledge-medium/src/paste/operations.js\":\"8a2bf603a9209e68\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"e47b8426ec630182\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"695e3e1c74607588\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4787b0410695f7e8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"b4f03b2b8262498e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"4f0111ef9c9b313e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ccd96f2a3bc8c26f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"fb7781f3bfad2a3b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"639dc760de0ca7ad\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"56736affc155d70a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"be4201cc88e34b8a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"6877d6b6e168663d\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1a3376a1149b7237\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5d33c624576a4536\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"7d53e5df2e2cc7cc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"2f862e323bd9a845\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"06c993983ef27617\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"790bd9f76ec2c0f8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7998e57a1592a7e7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"7a709e003891d06b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"4517cda970755da9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"a8425e64039224a8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"202677e93b5868ff\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"bca0568d94c1d312\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"28c365249956d132\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"cf85ccac0a9fe441\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"cacec0f9ae846bbd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"af1559cacc2c3288\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"96b4945568231e1b\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"05b2804d281b20ac\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"8506fe13d351bd85\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"ee5eaed6eaef63ae\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"c93bccb28ba22746\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9e6d8fb5a0551118\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"6ebfc2416ab75eb9\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"c4b593c90277bd99\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"b1cf23a19f00ffc5\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"ffe9a0985a6c43d0\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"33f8e293604cf966\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"4264fe12844a8d88\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"ecf8cde85b3406fc\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"ba988c892952196c\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"1fa38b78f08b58e6\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"e453d0251491356f\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7fe6e64cba37544e\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"a8b3205468bc4936\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"0465f5b76c9770f6\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"1a119f869587fc46\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"4747aed593884d33\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"254ef5ef8f74cdeb\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"fc6acb02189accf6\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"d697899685839321\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"d53de9b27d6d9193\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"aa8bdafd77a573bc\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"a7750ad123c3be92\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"6678f8e7650963d6\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"7a32bdc6e9526e40\",\"/knowledge-medium/src/plugins/alias/index.js\":\"ddf0ada412b179f8\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"f9e56a9b79980b72\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"b36d481da452dc19\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"6213a8faaba61d1f\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"bd679b02dcfb6ce5\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"6a2f2e393a183e38\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"04eb1e2a558f61f6\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"eb13cb57a130a1f3\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"01bd685ac07f5084\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"02e0331c894854f6\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"efa4b41cc46aee3c\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"bb64eb7c090ed195\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"629dc92ce1b5b0c0\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"dc4228b187cd1087\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"7f3c8a02bc4725cb\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"60b4588bfbfa308f\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"139694ff4185c520\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"d6747de8450fc3b5\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"8c9afdb5bd249a51\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"c54900edf9d9ecd8\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"8902b1de17b49756\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"75bc71b093194c67\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"272bfd3f7efd2ced\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"831419da06504cf0\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"44eda2966dc104dd\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"7a388ff760c993e5\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"b86dcd247d81e5cb\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"fb06b1fa73335927\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"a9a977bca838b967\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"27eb51d46ad834c5\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"9b231f7c980ee96e\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"688b1df962875b06\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"3bf27b241cee4770\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"b25f5a66f7349144\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"d90c22718d21facf\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"77b2bb326dcd784b\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"423a5fd9f6db1684\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"72641b835f79cdad\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"7170046b5af965ea\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"965d567d5fee6688\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"96eb070d7c49dee6\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"a1e06533f379b785\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"8c4b0dffafd636a8\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"b52afc881633ab8f\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"3c16898a075bea06\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"f98d5d31b3325e44\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"33aee967f47e2329\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"70bfdaf3c84df0e0\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"1cc3af35f45c22c5\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"f982641126aa6d25\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"874d266595bc9cf9\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"7014646bd7c2342d\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"6c50f0ac2ad78b33\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"713d4c3a9411e448\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"6acfb2146de04263\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"5c9f6276421481ee\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"21f9884c148d0a8a\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"79fac7c90704f776\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"89245971490db4f7\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"d01c86913ae0d1b4\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"f83c7641b7825599\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"28195db391d91205\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"2a9c0f1a1415d801\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"3f1a4f1dc9b0e113\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"e6d2cf5e9282622b\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"022c69f2d9370088\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"4669191d094762a0\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"a91c30cecd8d5904\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"1c836c5598336665\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"50bed470f1fb1e72\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"eeba80065c96705e\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"79196649649ce339\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"0a536ff6b27f61de\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"d1b1f1580911f052\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"d03b16eff19393bb\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"463d6635e11d0cbc\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"fdf5cc63c54a5aa1\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"dc9c6dda7d313b74\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"32efe2089ec66606\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"17db4b11ea754ac0\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"df7839c48023d9c0\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"93697ac0f43afc81\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"2ca1e33c0df8e960\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"199f67d18f4080ef\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0ae06e11cfb097a0\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"03769bbdd88d13c5\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"e84898c2ff7793b0\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"4f1d55f9d2dedaf9\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"ea70c75d7137f2fb\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5dcea0a1697ab64c\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"91a0bea447f3517d\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"7fa9877713a230a5\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fecc5e26f9f0fe77\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"f9683722cfdf95db\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"e3c3a7127753e4f7\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"6053b2aafb0755cd\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"61fc60ca1850d1a6\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"2794bf07acca317b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9c0f47f6b1a865c3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"3af09edff11da66e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"caa05684f85e2191\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9f1ac52ea11830ee\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"c8b4eaf3c2ed39b8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d865563e20988e68\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"6cf99265f8e288e5\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"597a42f09dfb3126\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"6b3f7edf38eff621\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"0ea9757729bc8e7c\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"44cfa6c1cc50d7e5\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"525e1f1de4a4e5d6\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"08a773de9147d786\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"6312bdb2a5e8f267\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a73678957c42ce20\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"5aba7876dfb682e2\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"79dc40be2bb1aee5\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"1c89b407da052f0a\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"3929a370c318509c\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"bdd6783cd65f583a\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"862d22484e734921\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"1448105475d81c52\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"7a658892a8e3e620\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"73afd9dcc09c585d\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"e72e8d71fc4d303b\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"3bfcd798f5deb149\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"31344b6b57d8b371\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"b0af897133448161\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7cab12470d9edb6a\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"a0c0c7cdda7f2230\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"2523cc8650760eea\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"40e31c919904581c\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"a718313e988d206d\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"e54b496fd39c9b65\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"4a3c0087cf4a0d00\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"5a6650e3944afe46\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b077b7538e1f7630\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fcb3c485a73c55fa\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"0fc7b227300663d5\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"5d2dda0c639214a3\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2e3f33356ab9d314\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"77941ef8e2781f47\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b2e3d8fa68fc19e8\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"ba52b397fa12f8b5\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9ff9a07d914f46cc\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"418901118e7647ac\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"20561bd0e5da2de6\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"a799a1913290cda7\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"f937b0647bbdb956\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"9b4d63103af9b4c3\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"bbcb54ba14792f25\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"08852e1353d10710\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"9e89ccd005778d4b\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"2a5b9ced06185d6b\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"177678ccf8a63579\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"3a2dda1f917b1991\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"0a3f9aa63fd2d1d7\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"e59373c58f8e0681\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"ebf91a1b163b5cef\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"949dfa1e70a74f4a\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"3c1d7ecb5328876e\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"682eef3cbc8cd7e2\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"748dca74d4f5c72a\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"40733dbf0ba7ec6f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"aad3926706bd8c7e\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"2a4906a506afe851\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"354cde1301cf58c9\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"ce13ba4ba83ea57e\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"db6891c6079c8a3b\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"f1edfe08c2a9e865\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"4e92b0b6085f260a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"18ffa35cb6b932e3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3753bc14ac3fd2d9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"e46eadb814ba9fce\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f894391a2564c2cd\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"16cfbe08dc5ab77f\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"340482b533ee4b22\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"cfe4594a8f119d93\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d5bd78a4a9c6ae63\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"deec79452b41a046\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"2003a26bc72cf5a9\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"2a61f549b73d1690\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"e2ee6a0280fb6278\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"7221f283c5c8086a\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"157210a0adfc8892\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"821dcbd07afdfad8\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"e4aca46293d31302\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"b6f73057cf4b4fe4\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"f924443c357ce73f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"5ece4357bf2437e6\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"eace0f08903e73d2\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"97971a6f9ae8ddd2\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"937c4010f4be44c9\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"78078f0715e65ba5\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"0f4731154f556731\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"d42ad2028d755f9d\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"2039f0dfbb46b4fd\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"b59260394171e28d\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"eeabac1cea045636\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"fc5775d24c6edd88\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"8725a27b37aec9f2\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"7555d37ed6661e6a\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"7dd77fcd64ff2703\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"140d7a341607dce0\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"fd14717a961eb39b\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"0b38e4a0a0b2c0b2\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"714f22a557f3d0b0\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"16aeb7aa5d8f7bd7\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"f5e9c19c8bce3e1f\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"96e86dba3ac433b3\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"61c29261e6db47c9\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"e147572a6454690f\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"cc31fe6580d7b34c\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"c762da984e68de2d\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"d33ab148191dcf07\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"eaf0c1f3ef26f151\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"93ec1606d87e0e6a\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"01e5eb3503e3effe\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"4ee0dfcfd71c338c\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"3cd0cdffe61ef448\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"09c16dad9a0531c0\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"7ce63182e5d059b0\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"2f06e9bdaad557a6\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"566af7c90edef99b\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"a184ab84f972c4e0\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"f31e4a6151e121f7\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"92756a5f528ea451\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"5c02680a5baca611\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"77799a53a5076893\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"41ff0f028b01fef0\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"e542b4b7a65178a8\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"7fed638834c42c81\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"cb8485d8591dcd8c\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"388f5a11beca41e8\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"b7e82df291d76c5c\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"8a0b0d8485940cfc\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"b9a4b4912eb7e25a\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"45d0c70a638c61d3\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"595697c9ac0dea6b\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"16bedd86a0a3871d\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7bca4dbecaf99603\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"44a4c06ef5868cd8\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"9de707b9a8b5f149\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"27f8e184e506db36\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"7bbf0794ce97b50c\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"f0911ea245ae171e\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"3c146c952401f88f\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5b4fb706de95a028\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"4ecd9ba1bdbad55e\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"53a7825db87ba18a\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"91fe975f95541e8a\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"6f4bea51fd7a5c35\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"35023e4b74617ee9\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"0cdaaf1b3752e7ad\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"da902515fa3913f2\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"0fb6d5d097a81c77\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"b1f05e1f0c58b91d\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"a0812db1b5aa09d4\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"c47e9c68949394b8\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"6027b440a3918625\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"ab662badf8e94fdc\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"38d9987e53f1a3e8\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"a71e426acf798f36\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"35a6bda50f8f9101\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"838c3806538e2f25\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"f77789441a08c5bc\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"cdba18e6156a7c11\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"4952b6b1727d6c78\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"3f8a0006a9a2bb92\",\"/knowledge-medium/src/plugins/geo/index.js\":\"9abc0414c247d692\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"be8342174ac1f005\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"c81ddf77b8585797\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"4bfc9378ff0ba5f4\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"bf82df8960fdbe1e\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"7bf49aacf9da2a2c\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"2d9cc0963e14f0c3\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"c9f46ab05950ad3a\",\"/knowledge-medium/src/plugins/geo/query.js\":\"0211e407bdd8cbde\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"38c425dd706b9610\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1a1e74aa8307b512\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b02111288fef3925\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"eca4daa426de0523\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"e6851bce76e9e5e8\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"599a6267ec03a86c\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"ea06964d020a41b1\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"166fd81bfdbce557\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"28876b1332748634\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"0c2efde27c86f259\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"2ab730d887c77e34\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"74ac820eb29531f5\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e21525e90f5de327\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c6db50ef80c3c585\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"263ffce8aa75a987\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"e49a43291053eb10\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"68ca0f31d5198626\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"fc767b764fff5746\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"3ac81d70d5572846\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"9eac975079408861\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"e14605fd18db2ea4\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"5ad85c8363b3be23\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"3e6e5a1210cd30cc\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b2ca87720ed5687f\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"34ab43d6c12d8b5e\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"b857ea28de95fb26\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"7683a380b55ac8a9\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"4c93bce6dfebfadb\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"5e0ab5c4d00e0746\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"5d137e7f943802ed\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"ef9f154d0fc37329\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"1b229aafe026c3b6\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"aadfffbeffdd6c3d\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9f281b322a0b7da5\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5ccf458feba13efe\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"fd22bc24028edf50\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"fd2df2df65bef53f\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"4627005c49ea6845\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"7cb11cf880918bed\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"23c5ecfabeb5244d\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"c33b6c49d4ac1690\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"ef4e09d27bc834b2\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3aa32fb64d1e994e\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"f22b4bdee99a16c3\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"4009a0bc691bb546\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"459875e2ac1239d9\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"d310bd84d5503082\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"2f59523cdc3e0d87\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"43222e10b6f101ba\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"419d276278bf0d8d\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"6949d96e5eb8d274\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"c5f8c8dd222d7078\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"0898715523275ea2\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"c37331fb4646e564\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"bafc665468d38e6a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"04ee52111f704408\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e5d5338ef441261d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"2578fb476c61a974\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"2fb97db0a43fd76a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4ad9ee4d16bc65f3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d616533a1d9b4d1f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2a11ceb6edbcc909\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"42c3fb6ef8729012\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"0f455db5423bcbdb\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"35b6d92af1606fe3\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"44c8d949b0646c6d\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"bb3549c580a81275\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"27ab7ffbc155b408\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"e13e9ed65c53a197\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"9676524ae0191dbe\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"6601e8f98c77f777\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"d08a399b6ae3a68a\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"3c157dc126905ded\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"117a2b028671cbfa\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"d82a092b62d412e0\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"b5d794236b197701\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"9659332322c557bc\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"8dbac3baa4b0d6a9\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"51aee02baaf9affb\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"07db88c0992df03c\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f4637739c9905039\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"3c554f2f3b69da95\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"ee479051a9cf3a0c\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"4a2c11f98c2a49f4\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"7b7cd25ef98dadba\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"74816df2d577bbcd\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"26b81dd0a93019e2\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"baa729ebd499b679\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"8567348756ec0bb1\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"2bbe2870a45cc915\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"e4602bb914a0d35a\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"0791838b4296d5b9\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"10b6ab43567331b6\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"be8bef28b0e2af07\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f3aa8c08854f684d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"6d3113ac5297fec2\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"b4a6fb599e3c04e2\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b4a9e728af330c78\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"d0eff0e2696b69a5\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"09a517e0bb3f7a4a\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"84f03573dec65a28\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"33ac2ef473a08141\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"3d572ac837746e4c\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"079459972732dd3e\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"ed1bff88ca716bba\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"dcb28f03de50e752\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"cea9a3a3dbcec27e\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"44cfb80507d3e076\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"5183f7ba287c096f\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"f035bd1a2adaa0b8\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"d7b7addcf7292e22\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"a3590ae6fa758fa8\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"ced716f8811b1237\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"94001a76063be6ff\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"360638215482271e\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"9080a52af04643d3\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"6c9f527a77ac835d\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"152047f2160db8e9\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"82452732c387eadb\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"77278d97597296c8\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6459432874c8e400\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"33d765b3a2553b4b\",\"/knowledge-medium/src/plugins/recents/index.js\":\"66ffd83f400ab243\",\"/knowledge-medium/src/plugins/recents/target.js\":\"305ca42db884b385\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"d45ad7d2edb166c5\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"e62d011605968a2a\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"d7a30ef33c5b9464\",\"/knowledge-medium/src/plugins/references/index.js\":\"334039f91b7cb475\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d763b20d534dcddd\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"7ef54f48b5403260\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"29b632953175ee58\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"839fd037ebac5f24\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d8962b06768123f0\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"351bdfc8db23f44d\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"8548938ede1c64b6\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"66a6ef03f05250d1\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d150fd0dd5271174\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"f967f3e224e3ef25\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"720f830795baf876\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"70c606ed1344ad91\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c7d627d7d49599f1\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"294be9c1115b8a47\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"db8db8ee9ae422aa\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"57a26e91a2fd393f\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"df9b2fe5d8c4cff7\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"5f06ff24f2ae2a03\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"c0016606f4277ff2\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"e83cbfb118653514\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"263e7ccac543c0d1\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"43ba6e33d6e2a4b9\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"9e124f542fc34bee\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"89dca8348ba3fe00\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"b8c3091ff9440d05\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"3bf3d9edea93a79d\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"96b91b781633833f\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"1d6ee28718233187\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"e30308b09ec25964\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"b33882828359a876\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"a1d6a52f97823a2d\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"7e6dd143d865c736\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"ff4527400535952f\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"2ef16ac83d1e7b98\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"2ec47764c5ebdc28\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"a145bd0db4356238\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"25f20f37528ab98c\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"9872f037f186e0fe\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"e185893acae6ead2\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"3240f3a69f96715b\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"0fb96a08ac70d838\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"d40a22a8250f3d2e\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"945ff3832761a181\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"edca2b37029881a5\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"0a066ced94ef502c\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"7291b4fe8feba197\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"42fde5335baa9d10\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"8836a1eb3c407444\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"fc20ef6f8565d8d6\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"31a8cab880df26e7\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"1cfa684dab490671\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"03afff733d12ab94\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"246ba0e505a3dbfd\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"473f22ebdbfd7335\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"52f6d525317c58ee\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"019476962ce979aa\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"34e56c845a76a890\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"9e1986eadc301276\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"0a00ede6fa092d41\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"60e49c91a63ef0e4\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"70928aa1c0b9b289\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"5b272ebdbb7cc643\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"0ac27f8ed5ea1546\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"78d47eb1cbc88794\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c3b609edde464422\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"45364421d4d3ee0c\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"304b77fb06614bad\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"be93dbb12c0bc79d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"56467fa1888c527e\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"07b5bcd537007bac\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6f00369ca4fe059e\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"b94e8461e524344e\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"5ac3519bc7def19c\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d00d54c8ecef5746\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"80d80377612cc844\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"1485b68155d75982\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"10a900513724967d\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"5edc9a2a57228a61\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"3ca42055a67e7730\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"dcf11146208efc1e\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"84ea77bdd0e4c612\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"1032e7802a9c7e84\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"0ef389a4ca0d7e78\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"8036972433847aa2\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"1b663133ba0d6025\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"a364eb4745a84d7e\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"377897d46686207b\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"f814399ed22989aa\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"0c4761ed0ab54605\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"d87d62adbf7a7722\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"dc3a32657c59199b\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"206bf7fda33283fb\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"d95cbb50099f1bfc\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"071e266bfcad6aca\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"7098fd4172aa9b22\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"9ec80556e20d5cbe\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6b5d17400fabba43\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"f0b057e4dec05ebd\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"43d6ad7105d7ebb3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"0a35c8988a8f9186\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"56981b0df1a4252f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"4d92ff1df0023238\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cc9e321cd178dac8\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"00d0e53cce4b5465\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"bb14dd7174bd918a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"882a77aeb47bf8a2\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"031fcabbce9f66f8\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d5e95546062ad82d\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"db5d7eb9edb88be9\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"8a165b9e97de9a4a\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"a69106b6fe42f492\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"0dbc94c04b2f7ad2\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"c380f640ae9e4b58\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"f9afb387a6caa577\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"72296a2204c88b48\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"34471e5dc74fc940\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"2339a84c00ce0942\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"5fdecded70e121d6\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"b1096dc8bd1041bf\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"56708082e075cf0f\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"e7db944804e37db7\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"8a606c39fbbcb26d\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"da49d895854c9e99\",\"/knowledge-medium/src/plugins/tables/index.js\":\"2ce857c637e2d8b5\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"a3c6c437b9e9d5ea\",\"/knowledge-medium/src/plugins/tables/model.js\":\"2b957198e0b05b0b\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"e20032ea33541615\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"3c485505a9a9fb22\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"5bc931b885eaffae\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"3597f0c8bb32b074\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"9088111009859bba\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"17de3a345811c926\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"2c096a71049f9331\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"feb98f669eedd826\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"c68b0c60b7435851\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"119fd030fb40c66b\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"89bd124210d705d2\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"eb0da1d8d3bcc6a1\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"9c1478a0cffe9115\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"802ffce3519c7183\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"698c8899afa4655a\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"ba6ff189a9d74e45\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"6ef288a0ca80d159\",\"/knowledge-medium/src/plugins/todo/index.js\":\"8375a0d0a4baaae3\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"7c95e99e7d258446\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4b46474d2c57f316\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"541b629281f3d386\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"1ad0f5d1338b72de\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"93a8b8451eccac02\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"2855e9f76ee2af76\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"87788b321a62da41\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"fb6fe53ccfb8679f\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"b66efa3130b294dd\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"30d641f471b59ad0\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"cba93073d6c70152\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"62d3ec18272fde2f\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"57ca807640120198\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"e06062387657b69d\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"64f3a4e9325bbf35\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"3a4e97d3e712451b\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"5738e78a8451ec79\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"71d537b11cdbe143\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"f1ecbb63dff58f14\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"cb186c10e67fe47c\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"e7c1fe626e5bbad6\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"bacac02feace4233\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"8931b6ba8593f53e\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"67de3b71ee05b373\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"bd920bb80e2a625b\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d40f7ac4d3016d98\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"072b1d9851f22cb5\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"d87c282ce3431a81\",\"/knowledge-medium/src/registerServiceWorker.js\":\"298ebd2b281b77ba\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"78af8a4cf879d720\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"5a314c5df7b90568\",\"/knowledge-medium/src/services/authStorage.js\":\"0e3dd23c0d2e0675\",\"/knowledge-medium/src/services/powersync.js\":\"ff6b3ae929efeb46\",\"/knowledge-medium/src/services/supabase.js\":\"d9bf66b30bcb400c\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"6eed4518bf9e4197\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"9a9c26b4d8f40ed1\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"fc5bb5369c3ed760\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"27e17deec84da8b2\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"60223e794b8bc0c6\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"d0158bda69cc8caf\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"f48f4b367a82f53e\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"01725f12d871b676\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"dd46f6043f930d27\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"04e51473b7b93189\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"e92237ffdb2a4c45\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"1bb7e40ef0322ef6\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"71ea6092b819ab67\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"1ada7fdcd266588f\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"5b038238d6d61515\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"613d53c33285feac\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"227d7d6b94df3be3\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"8514b0b6dcba0ea9\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"376bcc152f6e489f\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"03c83d75857d8499\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"8bbefcd399e9fb2a\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"8afd282f44c64d52\",\"/knowledge-medium/src/shortcuts/types.js\":\"1484182d04648906\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"2d8e98140385effb\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"a5caf8230dfe1de1\",\"/knowledge-medium/src/shortcuts/utils.js\":\"25a53fead61e7a95\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"850d822174b4e1a6\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"b690f1e8941b62b6\",\"/knowledge-medium/src/sync/byteTransform.js\":\"9aa3fd54495445c4\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"d7d0cbf1d6f74c29\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"d4361b0491e85032\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"6c8a7918c3cf91f1\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"6c31ceaa0ac70013\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"96d792996d3318e3\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"b1c6c5ccf9382d8a\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"fef7ca5e06e5678b\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"2fb9ef046ab7cabd\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"f66f936f1c92538e\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"cd7fad02e36a5279\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"bab01d685dada0af\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"72ecc09980cd0f59\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"d3a3fd61ea2e58a5\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"c05d9247407eda8b\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"f01353b20eccd95f\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"5532e7088c01b2db\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"70a8ac136d090742\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"efb3a87d786c527a\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"8b617e277c33d2a3\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"8d218c66648f4adf\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"ca2ca73df7e8a20c\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"6080857e8be50845\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"a229ed266bef565b\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"91e8c421f67fc185\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"1b9e4ff40b484a3c\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"97e457ae3ea41bdb\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"8f9fe92e68a9bf4f\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"17fd05a5a0646d04\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"ee05aaa8850367de\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"46e40384d6012a6d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"0ab0b0c2b6d9f8de\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"b340e6a9639135e5\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"34f85fbd26f052ea\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"2bc0da68d5093b70\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"c6f2da453e571d03\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"c59c22ab35e0e3ef\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"056696e87a1c293a\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"f65d8b73c9051482\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6f2ba8732f5a8a91\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f177712ac494287f\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"e6ac3d478f386e24\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"f9e744cd570e12b6\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"a25e801a05815df8\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"ab9928a2626becac\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"329619898d8fde4d\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"a3b22359e48e9239\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"d9231418765cfc45\",\"/knowledge-medium/src/sync/transform.js\":\"c661e53d2483195a\",\"/knowledge-medium/src/themeBootDefaults.js\":\"02ac609fd5ede956\",\"/knowledge-medium/src/types.js\":\"433fdaf496fe3441\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"fdaa2d09c40aaf6e\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"33daf19626d0226c\",\"/knowledge-medium/src/utils/array.js\":\"f030439c9e794323\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b20b589b49114e91\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"3ac60459eafa9135\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"d5c42f2b81dc1dff\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"b22b73d3de8a6cb0\",\"/knowledge-medium/src/utils/callbackSet.js\":\"14c55c73c8a05fce\",\"/knowledge-medium/src/utils/clientId.js\":\"5c9294714ee5a1e4\",\"/knowledge-medium/src/utils/codemirror.js\":\"50c6cc7433ad57ef\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"26109cc02974dc78\",\"/knowledge-medium/src/utils/copy.js\":\"21c0433f78e85a7f\",\"/knowledge-medium/src/utils/dailyPage.js\":\"d46753aa62fa80cf\",\"/knowledge-medium/src/utils/dbForensics.js\":\"d07ee277b3e47c00\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"8acdf17d9f36c491\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"cd97fd906eb41ec7\",\"/knowledge-medium/src/utils/dialogs.js\":\"ab0308066930b0f5\",\"/knowledge-medium/src/utils/dom.js\":\"9dcde5409e6b2db0\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"ad1e6db20900a7fe\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"925fbd36ce91c131\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"080ed282706b9807\",\"/knowledge-medium/src/utils/flipSlide.js\":\"892a7336e6d72ff6\",\"/knowledge-medium/src/utils/fnv1a.js\":\"4ceed607bb64d9ad\",\"/knowledge-medium/src/utils/formatBytes.js\":\"7b12ba7495b43aba\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"f7fda7aa2d15c811\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"85885013e885f834\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"c6851f8e3f8f976d\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"49435a9d5c0f3044\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"e97e5f8d42e4ebd8\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"060129b7e7298c15\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"9b2a348bd9482241\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"99f676797f3de815\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"126da9e2bae3a43c\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"a22e8a96d1896541\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"2ea6322102e7b4b9\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"ce5631baa2981429\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"5ab080cd3032dc5a\",\"/knowledge-medium/src/utils/markdownParser.js\":\"b15b9b06c6245b07\",\"/knowledge-medium/src/utils/memoize.js\":\"109f0d871827485e\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"b9650963ab0c633a\",\"/knowledge-medium/src/utils/nameList.js\":\"4c210a0da3f6ddf6\",\"/knowledge-medium/src/utils/navigation.js\":\"67ed9297fb85cc26\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"269aa462ba51f59b\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"530173ae7285668f\",\"/knowledge-medium/src/utils/panelClearance.js\":\"3a1856f810e7d55d\",\"/knowledge-medium/src/utils/panelHistory.js\":\"93cc98078e9dbeef\",\"/knowledge-medium/src/utils/panelLanes.js\":\"870297bc622245ec\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"4b2103181faa4b8b\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"6ffabee4aa981b21\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"b620b9f5495aa534\",\"/knowledge-medium/src/utils/platform.js\":\"11cefc3be607e6a9\",\"/knowledge-medium/src/utils/pluralize.js\":\"e25855d87c882a35\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"a5c0dbafcd779761\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"9004f05d8b2c1429\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"8426ed23b389b26b\",\"/knowledge-medium/src/utils/react.js\":\"d6861d178a6186f3\",\"/knowledge-medium/src/utils/relativeDate.js\":\"49f196cecf903ab0\",\"/knowledge-medium/src/utils/relativeTime.js\":\"ee91de0e6e4dd59d\",\"/knowledge-medium/src/utils/renderScope.js\":\"e599579eea83c001\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"07c0183ca2fb81c1\",\"/knowledge-medium/src/utils/routing.js\":\"fb667e6524472677\",\"/knowledge-medium/src/utils/safeMode.js\":\"685f8cd8266aa8bb\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"7e111e41d4b1216a\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"f5e5fcc0c3dce6c7\",\"/knowledge-medium/src/utils/selection.js\":\"f569ee6e6e38dc87\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"a238161ea858b709\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"88fc1bf08c78c38e\",\"/knowledge-medium/src/utils/state.js\":\"d26b9c5e06a6c668\",\"/knowledge-medium/src/utils/string.js\":\"df9ffb8f1fc9a130\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"e189de5e759cc5b4\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"ef43d3c0fa304e88\",\"/knowledge-medium/src/utils/toast.js\":\"b1e55cd95950a143\",\"/knowledge-medium/src/utils/toggleStore.js\":\"5d89f34da51ed3af\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"82d386648aeaf111\",\"/knowledge-medium/src/utils/userActivity.js\":\"8e467be9367f2191\",\"/knowledge-medium/src/utils/viewTransition.js\":\"bb1869435e68302d\",\"/knowledge-medium/src/utils/viewport.js\":\"ede2ef3321b7725e\",\"/knowledge-medium/src/utils/webLock.js\":\"9d0887f65662ae32\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"65944d0bd3d6f1ce\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"76dffbf85db538cf\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"b3942d06b57e8b54\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b49b02265a41985a\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"8a906b0fbcbadcb7\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"70037aecfa5b0dbb\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"699450fd5b77e7b8\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"34c408d807763eaf\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"7689dcd1a3286f40\",\"/knowledge-medium/src/vendor/react-dom.js\":\"efb32cf1c8405852\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"6f9c2eb7a88d3e6f\",\"/knowledge-medium/src/vendor/react.js\":\"0ed101458df151ee\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
	}, {
		caches,
		fetch,
		origin: self.location.origin,
		now: () => Date.now(),
		storage: navigator.storage,
		indexedDB,
		mark,
		bootStore: /AppleWebKit/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent) ? idbBootStore() : void 0
	});
	self.addEventListener("install", (event) => {
		event.waitUntil(sw.install());
		self.skipWaiting();
	});
	self.addEventListener("activate", (event) => {
		event.waitUntil(sw.activate());
	});
	self.addEventListener("message", (event) => {
		if (event.data === "SKIP_WAITING") self.skipWaiting();
		if (event.data === "BOOT_MARKS") event.ports[0]?.postMessage(bootMarks);
	});
	self.addEventListener("fetch", (event) => {
		const response = sw.handleFetch(event.request, (p) => event.waitUntil(p));
		if (response && event.request.mode === "navigate" && !bootMarks.firstNavReceivedAt) {
			mark("firstNavReceivedAt");
			response.then(() => mark("firstNavAnsweredAt"), () => {});
		}
		if (response) event.respondWith(response);
	});
	mark("evaluatedAt");
})();
