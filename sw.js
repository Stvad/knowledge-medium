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
		buildId: "4ca5db5a95ef-c59ef6b8",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"42e9a21ad8192ab9\",\"/knowledge-medium/index.html\":\"42e9a21ad8192ab9\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DNlbQUHX.js\":\"fe3aafabbb2abc9a\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"f93d5d62a4027f9b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Bj0wFkpu.js\":\"25f9528c200227c0\",\"/knowledge-medium/chunks/FacadeVFS-DwsF9R3w.js\":\"871000d649191c3e\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CywEogut.js\":\"b42b02b81ad69780\",\"/knowledge-medium/chunks/MemoryVFS-C3kixMxv.js\":\"2f536c9fe3bce992\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BZTMlXFV.js\":\"b7fa50e21efc98f1\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-8Ktv2BjC.js\":\"cc7ad91e64ee4752\",\"/knowledge-medium/chunks/Preview-3hKjBRbl.js\":\"ad5ebeb3b24721c7\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-ZJ62AXJ9.js\":\"d854abd8f6239428\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-axaAlDKg.js\":\"8265f83c745ae0b3\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B-6wb4R6.js\":\"88ca537516b82e9b\",\"/knowledge-medium/chunks/react-BJcsm0RU.js\":\"598e7e719e3a5530\",\"/knowledge-medium/chunks/react-BOQqY9ey.js\":\"42128d8f038edbe8\",\"/knowledge-medium/chunks/react-BTojx79d.js\":\"a77a167ec1212dd2\",\"/knowledge-medium/chunks/react-D5uy16-T.js\":\"a48fd64576cc3777\",\"/knowledge-medium/chunks/react-DYquk0il.js\":\"482ab61e8fbce74f\",\"/knowledge-medium/chunks/react-DgpWxoFM.js\":\"b0bd6a6cba67e123\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-D9QbfYOJ.js\":\"10bffe57e0c75f24\",\"/knowledge-medium/chunks/react-dom-server.browser.production-ZDp1MrRM.js\":\"5e0d970e780d9383\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Ko6rWxM-.js\":\"b567b87cfb1843a5\",\"/knowledge-medium/chunks/react-q3PcQRiH.js\":\"95b006b72d0d2fac\",\"/knowledge-medium/chunks/server.browser-uMuI1304.js\":\"d283b0723127dc23\",\"/knowledge-medium/chunks/textarea-DFarf8fZ.js\":\"eaa1bcecdb1e703e\",\"/knowledge-medium/chunks/ui-B3iJA2nX.js\":\"be73ee2af86ebc87\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"b5742446d93b888f\",\"/knowledge-medium/src/appUpdate.js\":\"68c35d24157a8b4b\",\"/knowledge-medium/src/appVersion.js\":\"bdd57cd214bca483\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"5ba022dd08c3ad55\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"9c3bf9b1873294cf\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"fe27fc1a24ba0ee6\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"1165268e15422f08\",\"/knowledge-medium/src/components/BlockComponent.js\":\"01c53636f981eae3\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"f6dfb9900c75fb60\",\"/knowledge-medium/src/components/BlockEditor.js\":\"bf228164cb609ea7\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"753f9821b8100ca2\",\"/knowledge-medium/src/components/BlockProperties.js\":\"cf0e68eba28e69b5\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"01cd4a34c28d65c1\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"ea817463d6f17214\",\"/knowledge-medium/src/components/DividerHandle.js\":\"9c81eb3d96397e7b\",\"/knowledge-medium/src/components/DraftEditor.js\":\"18f0466041bd969f\",\"/knowledge-medium/src/components/GutterPill.js\":\"bc93abf8afe78d22\",\"/knowledge-medium/src/components/Header.js\":\"3f30113ccb77e02b\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"b2a54bb3bd6cfc47\",\"/knowledge-medium/src/components/Login.js\":\"877825fc8291ecd5\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"d382a54b3caec712\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"5e77263cd6e33c89\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7adadef18406eac1\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fafe112df1513869\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"0a24a2ee239c2fb3\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"5bd757686d49ccfb\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"8c3552818425c44f\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"9de578f861cac75f\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"c888474fe2bdafb8\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"264a389a4507f1d3\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"585af21572778612\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"21463dc682dcbec5\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"525eec60070560ee\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"cdeebf5993964f35\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"33c101913774a9df\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"c99902fa195322b5\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"b77df8dfdd7ab167\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"b3de02c3d9f8d200\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"34bc7d526875af9a\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"299ff398c9609d34\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"69262c5f0290a7f5\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"2af9ff7b7685d001\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"97b1c37e838a5cb1\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"8f6e5e1dce2b6f8f\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"6c4f715c9beadd48\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"8df188362a9fd48f\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"8260f5254d2cd903\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"07916c2fea90c727\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"6e95b58de95a62bc\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"1f5abdb8256dd042\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"094fd17919dc51bf\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"223a57c58d725669\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"3a6b2aede2953759\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"618e9bd5dece6eae\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"06e8b9ddc67300a7\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"d217836f90089731\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"bef19c632f08af40\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"d2f4b783344bb211\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"0c1a206c20dbd2fd\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"db0b37be3ef28a3f\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"bb5ee33057c77fa0\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"7891bbcbdd73ab06\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"2ee9ffe61ee11c85\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"233b46cabf37e6a7\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"151651b5d7479938\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"512d76b6d8e11757\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"dd6423269530eee8\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"99f8fcca663e266b\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"1cccb93eee351e71\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"5e697605f5c1e1d0\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"dc0f414d2c22ab94\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"60fb844d414fc56e\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"e75ca29b7d0aba2a\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"164b58ecd8e1f817\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"ab79b3ac520a9506\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"82881e8f622863f7\",\"/knowledge-medium/src/components/ui/button.js\":\"11f063aa6f5807b4\",\"/knowledge-medium/src/components/ui/card.js\":\"904053917d57d115\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"84eef9bff91cbafd\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"ecbfcc3c8a35a607\",\"/knowledge-medium/src/components/ui/command.js\":\"296d61e3c00bdc3e\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"76004c85602654ce\",\"/knowledge-medium/src/components/ui/dialog.js\":\"65dc03e69e0426ea\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"9e0e891724004268\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"3a9a41d75545b485\",\"/knowledge-medium/src/components/ui/index.js\":\"1abe1ca88d9ea3ef\",\"/knowledge-medium/src/components/ui/input.js\":\"1ed657c24192106a\",\"/knowledge-medium/src/components/ui/kbd.js\":\"8a3a1d15bf0a9193\",\"/knowledge-medium/src/components/ui/label.js\":\"ddb2008550ea8892\",\"/knowledge-medium/src/components/ui/textarea.js\":\"f33763385e65f779\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"c2c198f62bf030b0\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"4813749163e5c9b8\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"9db783aa920bdda1\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"45e5502b6498e0c1\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"e7f7c42628c9aa05\",\"/knowledge-medium/src/components/util/error.js\":\"6d4a7604b27d66f1\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"6b5235365a3a9297\",\"/knowledge-medium/src/components/util/suspense.js\":\"c438510dce63fa87\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"e8b4466c7aa5e4f8\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"046e6f156860bc11\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"6126e3ebd3502a3b\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"51c09f705cde0a5a\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"9a424280e9a55ef4\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"283ca0cee09d8dcf\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"34519e3940b5d421\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ef396572b3ba7d4c\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"117bb4550498dcc4\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"61e6915940f5ebf0\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"a5abb15d700240b9\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"40100d5d999a0343\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6758c703ae6a4bf7\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"99b3021c44fee86d\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"124b2ff2d669e5c9\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"d4566047c6297eee\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"804fb1d09e4d11ee\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"21c5cfde538d03c6\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"ada83f9903560fe1\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"c01a305326f19556\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"6e54b12085ab1310\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"6b7532930c782b39\",\"/knowledge-medium/src/context/block.js\":\"8729c1fda0acc542\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"bd9dfc45befd80f2\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"e0dd9de2d81f2193\",\"/knowledge-medium/src/context/repo.js\":\"083c429018d9f0d1\",\"/knowledge-medium/src/data/aliasClaim.js\":\"0303a48d97faa41c\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"c1ab49e2edc0b339\",\"/knowledge-medium/src/data/api/blockData.js\":\"583a267639012cc2\",\"/knowledge-medium/src/data/api/blockType.js\":\"130ac6aece7a678b\",\"/knowledge-medium/src/data/api/changeScope.js\":\"b5ba3cab426246d4\",\"/knowledge-medium/src/data/api/codecs.js\":\"f94c9ba2f9941435\",\"/knowledge-medium/src/data/api/derivedData.js\":\"cef35a913a63f653\",\"/knowledge-medium/src/data/api/errors.js\":\"65639d977b749b6a\",\"/knowledge-medium/src/data/api/events.js\":\"4a43e2dc4b238dc6\",\"/knowledge-medium/src/data/api/handle.js\":\"c1bc4984e8b75c42\",\"/knowledge-medium/src/data/api/index.js\":\"c38c83c2bc0d42d4\",\"/knowledge-medium/src/data/api/mutator.js\":\"9ab452921d513048\",\"/knowledge-medium/src/data/api/processor.js\":\"7674208158579d74\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"eb834d6ea6b763e9\",\"/knowledge-medium/src/data/api/query.js\":\"0bdb62cb508dcbc4\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"e4b3c9deb69c77c9\",\"/knowledge-medium/src/data/api/schema.js\":\"c1bc4984e8b75c42\",\"/knowledge-medium/src/data/api/tx.js\":\"c1bc4984e8b75c42\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"d4141c821e0794ea\",\"/knowledge-medium/src/data/api/user.js\":\"b07e040ae827d21c\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"2b7862827657a318\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"c5dea35a9b61cf05\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"6f6b918b858f60cd\",\"/knowledge-medium/src/data/block.js\":\"63b80c8c7ed383af\",\"/knowledge-medium/src/data/blockCache.js\":\"0a250f4f6c33c40c\",\"/knowledge-medium/src/data/blockId.js\":\"58aa50d3c84f23a8\",\"/knowledge-medium/src/data/blockLiveness.js\":\"ce4a6522b7d65add\",\"/knowledge-medium/src/data/blockMerge.js\":\"02a2d8a574014ac4\",\"/knowledge-medium/src/data/blockSchema.js\":\"dfd6d2847934bb34\",\"/knowledge-medium/src/data/blockTypes.js\":\"ed299d826344f8e5\",\"/knowledge-medium/src/data/clientContext.js\":\"b9cd753a29e213b7\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"16d84a01ad8b5dad\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"f17e11ec42a556c0\",\"/knowledge-medium/src/data/derivedIds.js\":\"d0097211bd7fea20\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"a31f0416b83eabe1\",\"/knowledge-medium/src/data/facetBridge.js\":\"31979cb11354005e\",\"/knowledge-medium/src/data/facets.js\":\"8099d1d5dd1141a7\",\"/knowledge-medium/src/data/globalState.js\":\"29583d4b685ae2d6\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"18d3e804373ffd6d\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"214f8914a337cfbd\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"e81c7122070e5a43\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"bc95a11a4df62a46\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"5f6955d7195fdcd3\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"27e3922bbd0eb152\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"b2592ef3d18ef6b5\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"2da3f27366081c0d\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"659aa3740ad25257\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"e8e8e56db409405f\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"32d16dd7c05bb78c\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"a16177d463d16d28\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"5ddad95bf16f245b\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"443e7de1d7fb8fec\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"4cc0ca7af8419501\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"d760a0df300db949\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"acd12d33c718c2bf\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"268eaf9a8b3a514f\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"a73e32487f67808a\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"5e0f670a05861051\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"e9149bd191ceac25\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"261df128612f38e1\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"46e3417725317a56\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"242fe2f8c0e95d90\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"91f6ffc151f45db0\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"8400f5e4ef3e4315\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"d39dbbf99d96ccd4\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"8c18efb8edd97bb5\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"f35c1c0c05eca895\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"1fe3084c2c4529b2\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"4bda89b09086fd4a\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"f13e6a5f6d1c1535\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"2d857aa49b528e12\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"51f5d7396106dc5c\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"b457d3bb229b078c\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2cfe81cdfaf1839e\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"dccffa82fc1b790a\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"9103b4f9b561d18d\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"e5a43b68a7ce2dcc\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"2db1306561e7c1a0\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"b90c0337563afa73\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"fa99c753bff9bcd5\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"0198e9a4fc632862\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"c944a0b185bca6c2\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"c3e90589de0e86a7\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"b4f0e1b9bc41b468\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"4e9a837e4962a0e0\",\"/knowledge-medium/src/data/invalidation.js\":\"85e79697ab00d3f8\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"38c13c41741467c3\",\"/knowledge-medium/src/data/kernelPage.js\":\"129d07129b9ea24c\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"e68af20ced9906f4\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"8a2eb9d626377169\",\"/knowledge-medium/src/data/localDbStorage.js\":\"0917ae665ff9652d\",\"/knowledge-medium/src/data/localDbVfs.js\":\"b70c3fb268fa3385\",\"/knowledge-medium/src/data/localSchema.js\":\"e0a08a2cd064ae9b\",\"/knowledge-medium/src/data/maintenance.js\":\"ff783f44cfae4af7\",\"/knowledge-medium/src/data/mergeProperties.js\":\"ca24861c8be499e1\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"e0525714b1643037\",\"/knowledge-medium/src/data/migrationsPage.js\":\"dd2e36e9026dfdca\",\"/knowledge-medium/src/data/mutators.js\":\"a5306b0d83f3b620\",\"/knowledge-medium/src/data/orderKey.js\":\"d9c4ea91e2a81b9b\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"298755a139629b1e\",\"/knowledge-medium/src/data/outlineSurface.js\":\"9703810c1a6dc563\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"62de28ebf000ab26\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"bf12b963adec43bd\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"bc29211f19b42434\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"8e2f1a84c06809f8\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"7898d7fe16baf1db\",\"/knowledge-medium/src/data/properties.js\":\"bf2d7595e396c181\",\"/knowledge-medium/src/data/propertiesPage.js\":\"c5df03e644916b2b\",\"/knowledge-medium/src/data/propertyChildren.js\":\"d566a966cb538522\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"8ee685e00ff286fb\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"148ff2dd7edf5e07\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"d14b6772be5e4661\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"7e4c8d895fdab286\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"2380d47f12ed287a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"ff1e72a00f256b6f\",\"/knowledge-medium/src/data/propertySeeds.js\":\"47ee34332a6a8569\",\"/knowledge-medium/src/data/recentsPage.js\":\"a4577dc03f28f7c8\",\"/knowledge-medium/src/data/referenceBlock.js\":\"8dc0bf3d586da160\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"670699f5b9823407\",\"/knowledge-medium/src/data/repo.js\":\"4e85edacfea8f0a5\",\"/knowledge-medium/src/data/repoProvider.js\":\"9db72388ca9f569b\",\"/knowledge-medium/src/data/rowProperty.js\":\"9f80876e913bda37\",\"/knowledge-medium/src/data/searchFilter.js\":\"b96bc8d57639f122\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"257f90329d454f49\",\"/knowledge-medium/src/data/stateBlocks.js\":\"11a6bd7da482e635\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"ca2e64a4cfd0d470\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"f1c0c9687c0f1a4c\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"99f17db7b9c40346\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"522296bf35fb08de\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"36f480ff58f421df\",\"/knowledge-medium/src/data/targets.js\":\"ab3d17c98c281e3e\",\"/knowledge-medium/src/data/typeColors.js\":\"e0468ba4bab190af\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"a08cba7c3f509cf8\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"e27aa7cd8f99edd0\",\"/knowledge-medium/src/data/typeExtraction.js\":\"c6aeca061e7bea6d\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"8f66ceceb759b0a0\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"83643b2eeff802a4\",\"/knowledge-medium/src/data/typeSeeds.js\":\"44e7f9fcd0e0f040\",\"/knowledge-medium/src/data/typeTagger.js\":\"ce11babd70a3af2a\",\"/knowledge-medium/src/data/typedRecords.js\":\"feec6ea25f07741d\",\"/knowledge-medium/src/data/typesPage.js\":\"91faf8df3f9f98a8\",\"/knowledge-medium/src/data/userPrefs.js\":\"8527dbed5bdc4965\",\"/knowledge-medium/src/data/userSchemasService.js\":\"0dfa4c6709e92df6\",\"/knowledge-medium/src/data/userTypesService.js\":\"fea82c701d838a0e\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"536dade35529a288\",\"/knowledge-medium/src/data/visibleChildren.js\":\"19ba52daddc4d036\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"e4780c8faf8437f3\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"592f09d1aeee4b68\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"676228c9d7c546d3\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"0b31d1b9cb31a948\",\"/knowledge-medium/src/data/workspaces.js\":\"a24179362a11e54c\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"9f199b60079a89be\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"6c8f654f62655940\",\"/knowledge-medium/src/editor/atTrigger.js\":\"ad9e5898008301f9\",\"/knowledge-medium/src/editor/autocomplete.js\":\"ad6fd9463954d519\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"402e7787b9588c59\",\"/knowledge-medium/src/editor/contentFlush.js\":\"8784ff4f56b2b853\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"72419d3a01b1ad2e\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"fa642f6043d5581e\",\"/knowledge-medium/src/editor/insertImage.js\":\"16979610f3b8e95b\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"43648c1a68adc375\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"82af1bda40abc031\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"b8e1c5b966c99805\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"537d1e75d02e77d6\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"694c1f7af5f755e9\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"628b3c72b9178e8a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"575c14544fbf32d9\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"ae36017359acfb78\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"77b7cc78531d46d1\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"ab8976d0ed63ed39\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"c73d5d641d6cd27e\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"dba917f22dbb29ff\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"f61e3e9f24879ab5\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"74b01ee26dea2839\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"1bd5efd235180fa4\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"368fae41e50ded82\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"21da54e22e27f4d1\",\"/knowledge-medium/src/extensions/core.js\":\"84cf08c0f7a85c67\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"0d9d5f93ac982385\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"ae0b5238705f026c\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"20c878ee10bb6211\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"1af0802d800c2994\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"438dc59b30d95ca8\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"0e245e385604cf0c\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"bf592268136cc68e\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"91f0a6f61feb0374\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"f1007a70cba9bbf2\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"0aa06e99c600c40a\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"7c4b21e9fb5821d4\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"37e900794a0a33f8\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"a762b03c14f3079d\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6694366108b87d8a\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"2e7ccfcdf78fcb03\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"a196f523af0c0330\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"50541abd28c0eaab\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"bb79feb5ecf19ca8\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"efea2e89e23f9834\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"95a577d60a673c84\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"b0c15429c69c2a41\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"26da46f993b3db37\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"6f63705289bc50aa\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"21f63aabfb21dcbf\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"0f23075218865bae\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"230c83d215ddfc6f\",\"/knowledge-medium/src/facets/facet.js\":\"187c3ffd75a75190\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"03bc64de5679d8dd\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"9696694cdf4914e2\",\"/knowledge-medium/src/facets/togglable.js\":\"1a987852a825078a\",\"/knowledge-medium/src/facets/variantFacet.js\":\"2f7c6b56edc80764\",\"/knowledge-medium/src/facets/verbFacet.js\":\"500f235a87bdae9e\",\"/knowledge-medium/src/hooks/block.js\":\"04de1afe81f4451c\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"9e3f9186abea8516\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"f599b8a4aee66c9d\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"5f15ab4149433d32\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"7296a72831f87041\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"68278ca5bd2d1344\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"cb47c8e7e8a7d11c\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e82b4e2614d342ab\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"3d27f9024fa67289\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"b1453a5b83b22b8c\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"7622372bae0e3d46\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"dd57cac25235827a\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"2534cef4e7061834\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"9066888d74624f83\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"02ee70f736f97bb7\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"8897ffc185a57225\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"a6e7166feae1e2b1\",\"/knowledge-medium/src/lib/utils.js\":\"3464e7e471d83054\",\"/knowledge-medium/src/main.js\":\"5af131d3002efbb0\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"7f5d24b55d17b2c8\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"601484f170dbfa22\",\"/knowledge-medium/src/markdown/context.js\":\"979b1cfc7e110b52\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"5627a09e014bd778\",\"/knowledge-medium/src/markdown/extensions.js\":\"bbf13c91a723c04c\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"7210032a0a8592b8\",\"/knowledge-medium/src/minimal-editor.js\":\"8f66d6079acf1bbf\",\"/knowledge-medium/src/paste/armedCut.js\":\"bd6ae0efbcfe89cd\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"d744eb0d2930e87f\",\"/knowledge-medium/src/paste/clipboard.js\":\"2af4a4198ca61684\",\"/knowledge-medium/src/paste/decision.js\":\"7f4bd70e0e72a852\",\"/knowledge-medium/src/paste/operations.js\":\"faea3df0e46fde30\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"71f17e2fc93eb863\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"c94052d8f06f2e91\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"427eb7759fc60c3e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"ecba90b913263873\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"a135293f9ae0c306\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d3777085ad777e4d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"205d94fe99e34a4e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8708ce576629fbfe\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"5fcaff23c7f45977\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6639f0cfe261ea01\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"36b88d2c80a93ee9\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"5601fcb6dc2d7865\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8f57eb9c3b581007\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"c9f68c7302cd2a8b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"52497ca28eee1390\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"02a3e7e6f2348288\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"00544f2c127686d5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"aa42c3e6907eb017\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"de9c10cdf1e08160\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"70667997d01db4c9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"03c190ab33b07547\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"de3f454c5a2a2984\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"08e80e719724a20f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"94b5ab526b55e50a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"27ff697a41ec8eb1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"14ce5ebb8de0ed10\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"987ff95b24af9200\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"f808b55bb9c49fb1\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"41b557c0a9951a5d\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"25f9f6a1aa479c8e\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"54385cb50a2b0324\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"b78c19bdc5b90544\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"f9b93b41a5798139\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"7e34f5aaf95e6391\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"5561fa2af53d45c0\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"73450c82db39a8dc\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"f11d1a75c1d610d8\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"2e00bca08fd93ec5\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"9e4fce62bd0b55dc\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"55e1f0bf8b34b07a\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"2286cc56823cc446\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"a89c5bda4094bdec\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"b302c3652882e94a\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"71c9a13f44b18363\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"2ea5f6601df8c787\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"1dc13bcad1449613\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"88b1744359def40f\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"2d007c80a39d8006\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"9efd7976e9190791\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"158b18dc6695f5b1\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"3c3978a14d2bac82\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"b2c43133f392d6c6\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"8ae559d60b614b41\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"f103cd415a9312aa\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"cb9f92b754b891f7\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"a28e3ac40ec000d5\",\"/knowledge-medium/src/plugins/alias/index.js\":\"a9edad964fc4d570\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"e795421d72bd0e72\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"eaadbd8e7971cbf5\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"b4cdb6199f5455a1\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"1aa57ab369818e54\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"a8cdf2387f68af14\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"e658e99a2273d131\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"d1326316f4173703\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"5b03dee6f3d46abc\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"695aed8611b22177\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"ef71474d504e766a\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"3fb545bfad3ed553\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"d9d8f6d51bea829d\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"2a1db42f64888c8b\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"860c1c70bc03b238\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"be169d889430a521\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"44ee1295bf93749f\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"6e7d6806ebff5e6a\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"21ad31a0baa57a29\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"8fdd061904c4f149\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"a32037eeb9c6ee19\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"5f4279e1d08f9f3d\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"fabe16eeef0060a2\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"5834da295a0ee89e\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"ffd42e0c9f0011ea\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"e9bf5558fd9385d8\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f1bbfb4c52d12ee5\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"9dc7feff39437545\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"5c8385611de21d4f\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"d207c075aa3e12af\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"6fba053581e056f1\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"8593e32a81601cf3\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"eedb77bc61b70e57\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"fa5a747d47dcd260\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"250a7ca873949d04\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"6785224d7db8ca5e\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"957c8eac01887c45\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"e0448e034e46f561\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"be10e1b6905344b7\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"ce827b6298ab38ba\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"95ae75ba726d2623\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"0eedb2ad4ab6f20c\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"f2a5a294611d24d5\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"85d08eccf2fd8acf\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"2468a51918fe25a4\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"2fcc7f28d6317961\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"886d0f730a4cb086\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"b9ccb7da8df9d44f\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fef35fae754b6002\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"dc44bea67e6cde7d\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"45384adf5a162096\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"db542faf068f2251\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"b834904c8cfb75e6\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"13d04b0d66590874\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"30e180e5b719348d\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"23c4b9fae2168bcb\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"009665cff2ce68b4\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"26ffd69a35cb729c\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"6b21cf4773d7bc4a\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"1257135c50def0bb\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"63fcdb3d625e2aa1\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"e4ed12937fc261b8\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"9cb4ef3b4442481f\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"0ae8f7c117097a6d\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"7b9c7a22800734e3\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"74d399737f5d849a\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"1b8af50c5f7bb98e\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"2966ded68e849e82\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"1bc246283f62cc0c\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"9bf63a9fc74b50bb\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"1490fcc50ff2bd79\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"2b7c6e6e5c83f275\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"4dea891c65357be7\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"31f3227c448975c1\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"a91df8fa6cc2e996\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"f2818a5a0739938a\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"21aaaab01ed6601e\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"83356b4b517ce6a7\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"9bac11f4506cb1a7\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"9971a9c2982d36b2\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"97872544a6b79fe2\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9f5b74d71fefa942\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"579bf0d3f78a081b\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8638b47f5f5502a4\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"96b67ba08bc9efd5\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"f1b0d1b95c6a205c\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"e216aa70f39cef68\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"43c8e887a9981c4b\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"29effe7df25d1087\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"84c925893283f9d8\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a7d347d83465a6c3\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"e7d032bf17adcd1e\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"0b37355e2df57977\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"c01c15694a34a45f\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"6561381dfe511059\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"83b86dd3bb34d6f7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9b74e995dcd38324\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"89630f06716b11dc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"7a7f534794ba5b97\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6c272999a593e2e9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"1a4f73a2b778d16c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7ddddd46f093d2dd\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"9caaaa38c7ce3d3a\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"3d41a8de442df272\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"ee94e5ff5f7a6c1f\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"106810d57893a041\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"62254b1ced019cad\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"58aa6100b2326606\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"aa6c7f09250f119f\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"9b9fe4bba18dd250\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"571fbed3be9b3a9f\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"0b527f952c5caadd\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"ac53bdbf93c86e08\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"a1b8a96547f2fda5\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"eded1d8523b15249\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"d7c2f3f12f0f95b9\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"7fb592d7cf83e963\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"1d66805287e6b605\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"6adcdc1afbca442e\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"5ed7938290191ce6\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"7ac73f3f3856b75a\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"5bd36496b48e9b18\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"a13003743a999558\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"d1bd08327fbc8c7c\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"08ce07064a0b51be\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"f96425bc558e56c4\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"32f03701fc87d5ad\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"fe597166d86b0799\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"72c5fc8c7790029e\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"8e1d9a23e9c16782\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"e885d3b67d654775\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"e91a1f8e6ad80d51\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"16cbd1b360c0b2e9\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0e883224c8ec91af\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8d89db4e44d3a799\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"25c2fcd3f9efd2d6\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"95dff44e96ee7bc9\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"9cb8c4ef2d019c4d\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"04f5263f78fdf2ef\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"1408ee9195dff851\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6b7b0df35bdeba0a\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"8a6c6017d78d630b\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"f87e50a785fac00f\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"bccb3c3583380773\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"1c4a38b593d9665a\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"348d32564630f459\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"42380bfac778b4d8\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"d648b963e28f942f\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"5710a8f3033bb449\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"5305417d8ba61190\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"6bb16382f606a36b\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"fd12f7ba5cecd2f1\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"c5700bbab2194a11\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"8c118b20875d7698\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"6faccef10afdaebd\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"805db1dde6ad54c2\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"848c065443620352\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"7a65066c25b799a9\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"d6c96370ef15046a\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"65db1291e4588c16\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"0533953d15f17214\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"6ba2f485e3c592e8\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"2bc09275eab19174\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"998bf6b620673174\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"64a85a922be40d28\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"bd1c036a42e18c73\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"12f1df19c212764a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7700255470d46b88\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ab6390da69fe01c3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"a32d08279a057f48\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e0991ceb2e2fa0d1\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"939d9ea279b4bf32\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"703785f9cca23291\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"235850f355f9e05d\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"715bcc18c311c501\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"97cd3bb5ceb108a3\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"16446f137824a579\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"c6c51a6dcb01e704\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"0b296a3df116e5d3\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"88a6cbd9382bb4b0\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"d0578e15db9bde23\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"7fa269bdde8bcc15\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"e462379ace0cabc7\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"57962afbb7ba6975\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"bf0808e33a19a63e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"06170297467f8a15\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"2eca06f90410a274\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e89c5b2c694a4cd8\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e37fd6885a250e0a\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"71a72072078104ba\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"e1d07e20c98bdacc\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"f5509adca695c480\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"0a4e5268252f6d94\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"ceb6204cf86264ef\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"ef628ffbaab82df1\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"936dcd4b5f2f8dcd\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"b2f7bc260c1c828d\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"fbb6d20c794ad89d\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"7795fa3a96fdc57f\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"e6a6164a579a30fe\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c1d1bbd136e94335\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"80e9712b2aa16225\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"e2f2639c0ce646d0\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"76188301d4dee68c\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"4a6bd49607895175\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"ad02aa54ce140840\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"28ae0dffdacbb34f\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"a307d6e862e4fded\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4dc59aac6a686702\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"28343904edf82934\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"51645954240a41d7\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"96f9ae2bec2df1d1\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"e81ee7c601209a5d\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"bab70a86e58fc333\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"6f82821d6ed89daf\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"5f3fc58c2232adc3\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"311b0935ca47ce27\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"95825f8f863eeb56\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"5b4728b9df1a1ba1\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"2c11fbf7c4f855ea\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"0eaae92637d2dbec\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"3473a9e613531d63\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"3bc6c483611f6709\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"0a15d6a9b042a306\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"9a353ac9b2223b04\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"54e978540d8d806a\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"e7d59946ca82d9d0\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"517c75cbb6599e4c\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"de29c146d1566bf9\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"998aa29d6ba34188\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"d77e532db8a5b7d6\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"55279ea54abb3ca3\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"bfeae07dec665a46\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"6ab3829aa11518c2\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"e2120edbb7600d0c\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"17f66a3df621c48b\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"936e9fd1f62ac5cd\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8780c52b547acd37\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"f10ebc53eb6eb12b\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"301e8b8f884034c7\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"657619eb501a977a\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"0d6e9c92dc6c5939\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"6a481b8eb51bb15d\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"60fafec7dafa638d\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"092bdc692189d353\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"4ed1ecf14120e4e2\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"02df667bc2eeb702\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"e43fdaf3210cb546\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"7c6eb57ab115bda9\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"30f91cf072adda4d\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"fa29f4ebbc993e68\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"a984106cd3aefa13\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"a14eea33f4bb8b54\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"8cb16fe26857b740\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"b93c222033668c87\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"32088333a4a0dace\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"530f379a584b96a0\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"c3b7ce6c6bef6c15\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"a7e9e3241d1f9623\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"56551d908618fda5\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"46c682173c569a4e\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"6e54ef37c716baaa\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"61173ce97411755e\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"cae625e7c9041d9a\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"4df4082d535a4d74\",\"/knowledge-medium/src/plugins/geo/index.js\":\"4e76c70cc817572a\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"cda36d9282a33a6f\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"79ebe322563c9abc\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"a7d4ac94917757e0\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"2e2165d37a6c93a9\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"91e9baae9df04e82\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"07e5d8e9125a0c68\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"d7d6ef2b75e35c80\",\"/knowledge-medium/src/plugins/geo/query.js\":\"95650497f595f38f\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"cb74b6ae305f0039\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7b4ca0f0ddbc2720\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e75c56e6dbada954\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6ceaa8c1ed7c6ecc\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"4aa1517a597b354f\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"78585e21c856d38f\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"a39e3640810e0a9e\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"d78cd4234ae4793b\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"995cb22223877a48\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"39fd2387deccee25\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"b862e5fd22bdb206\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"940c63c8ff9e4ba2\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"55282a8ecede2de0\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"70cebffa78741923\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"5a7c11fe8cd139c0\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"6203b40c46c03525\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"e7158e8d50358a69\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"360d0a0276f2cdb6\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"13e0a17a50388186\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"8820f8708b0304e6\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"4a17c8459cad300e\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"2e59532bcd191115\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"eec2fd14f3d136e3\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"e27895f68e1f8893\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"fb475aad5b0b6090\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"9ee5a4cee6fc77cf\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"36604eba16946b69\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"f99531337f6c7260\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"434632aca8428d9e\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"2c603b9603dbda5b\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"365e51c729f7a83b\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"30d5a7de1d6c9d94\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"a0967ed833c619fe\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e313f677750dfb9e\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"16c509a6c91f1b01\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"b9136cefcad39684\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"4e63137b2717dc91\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"d8e41bf25035e736\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"1b9b2a0d89d247e6\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"c6c2b71105d260e6\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"d06849ae576743bb\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"bd899dc5f1995e6c\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4533cf246a98547b\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"91d152c5633ed434\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"136c664b4ef10b74\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"68bc19d9fa8dae96\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"88826961076ff21d\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"9a41bee94afd1f8a\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"986660f0b6b22a23\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"bd4ec6a73f22316d\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"1f0e94c2a7d57a04\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"b4dcfbd2f685af75\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"e00b1b043ef80061\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"0a25fd6bb00971c0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"31c1450048bfdfc0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"dfe6eb301c784060\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f9154ff385c9ade0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"2c312a8ce8069e8d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"8e67491ec6ef5ed9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"71d40c77f5c96027\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6488a6e94fd3d597\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4ffc5f3e5ede8a89\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9e26c5d56b8e21fd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"b23c33d5e3a3aafc\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"907dd6c94c445d4c\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fe64c270b20511bc\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"5878380e9a0376a7\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"e21aedf6af58c22c\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"08c606624f9959a6\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"eeb898076e735ac7\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"3aa672a5399f0fd6\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"c26161f99b32f102\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"9d471d1c5ea3c347\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"f8ac9d5aa996c3cd\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"79d8d06c6a633321\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"6a8bd30e94837650\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"e68186f5b280622b\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"442476c792b16f25\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"57286ccc9c3aa6d8\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"b04f3e2012f1c2d6\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4dae861e6071b74b\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"87abb60b6e531085\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"0e263f0ddefc1bd1\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"b122a34bc2a08c0b\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"9d8722fb7522956e\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"dba13390157e15c4\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"bc09fd8f4f07b7f7\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"f33033895d34fd9e\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"a2eaa3bbabfc752b\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"4edc6700849f82b5\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"aaf4ace05617cf81\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"6798e10dfe741385\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"3caffc40f638e983\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"46befe35e158f76d\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a4fd1cc98d187102\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"f8734063a1791913\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"3bd0e6187f78b0a2\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"58940dad89b54842\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"980da5bd5961d2a0\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"64e5eba8d1b2f0d4\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"995689183f044247\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"4c1fe3b741e98120\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"5ddf07aa3beeb88e\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"04fb4c651d2181d9\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"87bbc6fd9e663905\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"f74a3710dd5f7b42\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"683690b1470db1e6\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"92ab788e485b7d44\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"2a4b29ab7ff0f2fa\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"9f0fcf956ae4de38\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"1355daca95ff590d\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"9f9d8e121ca37fc5\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"8e8fe4778ef64fc3\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"e383404b3a91435e\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"3f2bfa509768d7a4\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"68a37e4236253ef7\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"bbb47aff2294c149\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"8a1e7b5dcf0740b3\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"5743e3c448d8fc6c\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"8dc18808130daf3a\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"41186cac6a391c63\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"cbf3f48cd33e161d\",\"/knowledge-medium/src/plugins/recents/index.js\":\"e75f86f90f1c2c2a\",\"/knowledge-medium/src/plugins/recents/target.js\":\"770ff8c4ba8a23dc\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"a50a0c6dcf826713\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"b4a9737e69d927a8\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"d799d8738691b6dd\",\"/knowledge-medium/src/plugins/references/index.js\":\"ca467fd4589ff1e0\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d6c6e13c9b3d1154\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"24eba02bbd5e0197\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"d92e5568fb97e0b7\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"c962b3e9f8df1122\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7c2dc9c66000173a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"83dfd766e60f6f41\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"f6381da465553982\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"851e534f1b73ea03\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"972feca3af4e177c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"b1d439c5a1056bfb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"842e22f4841bac0b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c4e55f8ce8a6d38a\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"0bb48aa26e82f430\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"a3c949a4f5d2435a\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"127ff3099d5b3735\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"ec19d1c22e60baf1\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"be451f2e65558087\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"1d21f1e3d53c5e2b\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"837f57d0595fc443\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"5c336e8b5bea4430\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"435274428cdd06cf\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ed8708822ef90c9a\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"dfa3e3e16ecf3d23\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"8a964187abbed6e6\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"9fd289dfb37186a0\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"c545dc4a47f89911\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"6e417dfc915d7a57\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"7f98bfbb95f43324\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"db0990db4ffc2597\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"96f3f476589aecf2\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"52f7a41fd77b3035\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"71badf762ed825ad\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"1abe11156e4a1c4d\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"02e02becb6b03167\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"380f56c2c01e4fbd\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"c6b41798677bbb9a\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"d93b255a7412517c\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"bdac90c77aeed3b4\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"87f2026103ccbf18\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"0e5a0d7136e9689e\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"c8042823b2d01544\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"30a82cc559d21f21\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"cc19b61577575a3e\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"b614676dee1cef0a\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"73687ffd115dc99e\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"b0c910404c065359\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"632e2c46f404951b\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"b4a8cc2ef90d868a\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"ff450ecbeb30ce4e\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"3bd287992dc09d89\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"6ed9a293d1b7bbff\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"41b9ed9b77300ec4\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"706320a8b2688107\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"44d705e3105d16de\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c3bf315ce9f935aa\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"2842d10c832e7a72\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"72b71ff3c56a6dbe\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"a6a3b75f081b953f\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"e5f3ee14e52c4d4f\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5bd07a8d2721936c\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"3c60f9ac65f4cb7e\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"ec1ba16545f9f572\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"6e5faf611cc544f8\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"a651f0a5918f04da\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d6c702d74bb5f3ad\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"79643be5e13a6ef8\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"ccceaac14049dc49\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8b4e042369981042\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"b212cc39be3f7abf\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"06cda10df0044362\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"75288ad2e8ab4df9\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"0bdd5c1340fb8a56\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"a6a02beafb51a2c4\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4fb97febf01f01e4\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"3d85bec97c36424a\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"c74973f52e7ccdca\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"2af321f543fdea57\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"b284b6655a4c8709\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"133d3540d9e00adb\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"c99a1358ee5f0dae\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"ebaf0bdebe017577\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"b8ad543e814105b0\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"5fe4b4749258643b\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"6461f2a3c19a0a7f\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"bf0b25179370d5d3\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"1f754e4f72988459\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"fa5461467ac736e1\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"8627f6904a7087f3\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"07a54461700c037c\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"800f607cc9306ac8\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"f3e7c7af97dfb830\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"a1bc71be4ce90e4a\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"22ae28fc75dfbd73\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"5eb710a3987970ae\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"0c6e25da346aeeb0\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"4f84d8af543dc62d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e46a1fafdc94bb8a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"12b590aded754816\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"c55a27103b8a274b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"c2f1d72aea51888e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"95eac07ab1763e4d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"4d5771fb6ee5a26f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"520cd03ac1a5c6d4\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"556c7186205ee068\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"d79e888a86367c74\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"46716bc5e0638ee5\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"433936b848abe4a2\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9bfbabeb69cbf4d4\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"9f3bd684deaf47f0\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"e9a5140aa05d8c3b\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"8d7ee86a15f32f7b\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"f94968ac4d2b40e2\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"b7f41f87c6863923\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"9218d375055bc5e4\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"6d62d52dd95cc98e\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"ed8ab3a182cc9be7\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"4a9d3fd4a864c3e6\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"fa1ead5cb258422f\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"0f7fa06b4c660b44\",\"/knowledge-medium/src/plugins/todo/index.js\":\"dda8fd41ede05dbf\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"07bb7b7e987d46ea\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"04bd087850ab57ba\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"6312d0ace028d38f\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"fb9e0db6de36bfcb\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"27c1d0e7db38f526\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"435851c87ba6690a\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"1759adbbbefecd1d\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"cce850db0526d494\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"9851655eb6d436c5\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"147b3ae12d0990e7\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"7d81b708c1b01da4\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"79d8a78dd337fcb6\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"5a473787983d9379\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"657080887c6fd5a5\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"7c56a29ee92aa0d4\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"c6e68217ebce1ee6\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"43ab864cc1af8945\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"a2a14823be9cf4da\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"8c9caa2866414b8d\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"884beede29f450ce\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"6b5634732d5a21b8\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"027e1be707b57711\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"203e2f817d7fec05\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"4982a8c374435bc3\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"c1561d1e654bc08b\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"947cd6593f07ea00\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"c2c9e0d99030b41d\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"8c35a13255ca83c0\",\"/knowledge-medium/src/registerServiceWorker.js\":\"9bf814328455f2ee\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"a7691c1fe278ee6c\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"31f36d6f1fbf81e7\",\"/knowledge-medium/src/services/authStorage.js\":\"b7c43bf833540848\",\"/knowledge-medium/src/services/powersync.js\":\"8636a0370b203331\",\"/knowledge-medium/src/services/supabase.js\":\"b33326fd1a483a73\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"aec29d03a2ee70af\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"151a301a24d7e609\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"f9626534087b944c\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"a382f3b02a74c54c\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"3be16ff009ab6bd8\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"9f9a32f3bce90a58\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"6ae6df5ded86a4cc\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"b701cb7b023b6dd3\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"624bfe2ad4d3d1b5\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"d96589ad1f228c88\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"28548733f51e7777\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"56d347dc50718fe1\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"21ad718cf384225c\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"0702582ba852ed22\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"67d857a887dfc844\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"90fd328c015b2a8d\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"dc90a274cbb593a4\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"2e9b180a5236866f\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"1e9eac9cd48de246\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"016a5db2f23c9d43\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"f42acf2924697054\",\"/knowledge-medium/src/shortcuts/types.js\":\"2adca554a7e3d0bb\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"0c697cb62ab227f6\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"2fa830e4bde8067d\",\"/knowledge-medium/src/shortcuts/utils.js\":\"c1a6d1204f63ec1c\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"e120eacea1271fce\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"19b38329548dbc57\",\"/knowledge-medium/src/sync/byteTransform.js\":\"f45a8dcd017a55e8\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"1bdeec3ae615f7d0\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"c51c77a4549f1104\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"7276b84532857e27\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"f72687aab54991fd\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"7a0bca8ee8648537\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8d52e49c2286a312\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"52ca1cb027d6a518\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"5690c5a7acfa492f\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"b0dcab5c8f026e6a\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"747fc3e87767f1c4\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"8b11a1d7d66cdb01\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"2f8549e9d3564e0f\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"32c4843b9bf2561c\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"0bb3a4422fd152ac\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"56d3de2d9a886953\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"4fa3c92ecacfdc25\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"77c7d16db75b5e40\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"32de388f88a55d34\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"c59eb225c4804e8c\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"ec5e9bcb0b845c17\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"0fc58d4328817539\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"ba4c35d9d2e5c093\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"e1fd156d899192d2\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"de3c53751355799b\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"99c4cb95ba5dd19b\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"c8237e7a98859bc5\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"226516c4615b6966\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"32ceac533821e504\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"34fb6849ac96fd89\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"d2a314747b3e77c3\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"d678e6a4651b7453\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"421468a14ed18d86\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"1389dfe9a90f6f26\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"03ec1b9336b46a91\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"83f07894ef5267a2\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"c6e486619f262750\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4a5409186a170675\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"64be2ac5fcfcb4e5\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c2ab6d6cc6eb10fd\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3134cc8a484c663e\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"cd2938728233469a\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"bba21cbc8280c0b4\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"86a19da5456d83aa\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"a3d47d657d4624b1\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"7c598264be95288c\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"42790c185e462c36\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"b8b3f74f68de8521\",\"/knowledge-medium/src/sync/transform.js\":\"c7818d6ddff56706\",\"/knowledge-medium/src/themeBootDefaults.js\":\"f11dcab26f1e2500\",\"/knowledge-medium/src/types.js\":\"8e9803c35dd90c7f\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"6bbb3cb37a23742d\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"35f3c4098b9e14db\",\"/knowledge-medium/src/utils/array.js\":\"05f74f3a0ac622e0\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"aaae525a3d7d6257\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"24624ba840f7ebe9\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"310bd09d4ac7cb48\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"d92e679c891d0ba2\",\"/knowledge-medium/src/utils/callbackSet.js\":\"e0de3722a70736da\",\"/knowledge-medium/src/utils/clientId.js\":\"668bf9d7bf814068\",\"/knowledge-medium/src/utils/codemirror.js\":\"7aafc0e921d286c0\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"c41bd17f41f0c4f0\",\"/knowledge-medium/src/utils/copy.js\":\"fe4f4ed3b71c9e9e\",\"/knowledge-medium/src/utils/dailyPage.js\":\"f834931e9a739564\",\"/knowledge-medium/src/utils/dbForensics.js\":\"296e5f4f2fe3cb9c\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"f5490b2b35e35f8d\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"038615d4337df4e9\",\"/knowledge-medium/src/utils/dialogs.js\":\"d0a7debb53b1ebfa\",\"/knowledge-medium/src/utils/dom.js\":\"4176082f2322382f\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"2e025dfbb8f5b96f\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"788e282b848ee673\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"68bccacda61b3787\",\"/knowledge-medium/src/utils/flipSlide.js\":\"60e7ddfb43266276\",\"/knowledge-medium/src/utils/fnv1a.js\":\"2411cf778ee216ed\",\"/knowledge-medium/src/utils/formatBytes.js\":\"9e459379451eae8c\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"483245eb1212d3a2\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"fdfeedbc95a7145e\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"965f617599a0cb27\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"00d5e634c171c18c\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"ea29874fe16976f4\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"1cb677c55941112e\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"9ad1cb42f335aa39\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"14b35822bcb40c36\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"b21c7de753312794\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"2ab81b30a9e5dc82\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"8c3606051a400d73\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"ab03bbc734842e5b\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"37cc06a9c7cc74e0\",\"/knowledge-medium/src/utils/markdownParser.js\":\"9fbd345ff76ddc20\",\"/knowledge-medium/src/utils/memoize.js\":\"1e9743715aeb6413\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"c5445377cb71743e\",\"/knowledge-medium/src/utils/nameList.js\":\"e3de989e6af71316\",\"/knowledge-medium/src/utils/navigation.js\":\"9c60362e999572d8\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"a344e7461e5e3e27\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"d8536f9e41d936c0\",\"/knowledge-medium/src/utils/panelClearance.js\":\"6bb17f1c533f1699\",\"/knowledge-medium/src/utils/panelHistory.js\":\"d83ac60de59795c9\",\"/knowledge-medium/src/utils/panelLanes.js\":\"d18ce6a2ccd84491\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"069650e26788ea0c\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"5d2e47de35a53249\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"ee892234a8b58d4c\",\"/knowledge-medium/src/utils/platform.js\":\"a2ac9b17fb16ec09\",\"/knowledge-medium/src/utils/pluralize.js\":\"13c2a0171092161e\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"f9d7f74c835a8e50\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"626f9d62ab881586\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"531277d44c7d41d9\",\"/knowledge-medium/src/utils/react.js\":\"0761aec5cda8a31c\",\"/knowledge-medium/src/utils/relativeDate.js\":\"e69249408fc87806\",\"/knowledge-medium/src/utils/relativeTime.js\":\"d8177bf29fb459a6\",\"/knowledge-medium/src/utils/renderScope.js\":\"90bb7594ba084b36\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"a092b54727d1d0fd\",\"/knowledge-medium/src/utils/routing.js\":\"560cdac80bb045cd\",\"/knowledge-medium/src/utils/safeMode.js\":\"5da800805cbe2841\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"cf7c8afe27861504\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"9d1cf728a3d3394b\",\"/knowledge-medium/src/utils/selection.js\":\"7a33f4c904f6b5b1\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b2b03334ad75a043\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"24afcd20eafb666a\",\"/knowledge-medium/src/utils/state.js\":\"f566b4455d7e24f1\",\"/knowledge-medium/src/utils/string.js\":\"d2ff7e4563407102\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"ad49798847206a9b\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"4f3879de1a7444b8\",\"/knowledge-medium/src/utils/toast.js\":\"48e981f4d3cb8841\",\"/knowledge-medium/src/utils/toggleStore.js\":\"873953acbf9ad416\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"f70c3c0c36a61c08\",\"/knowledge-medium/src/utils/userActivity.js\":\"10829d2036e516d9\",\"/knowledge-medium/src/utils/viewTransition.js\":\"60ee1f0e4e178354\",\"/knowledge-medium/src/utils/viewport.js\":\"57aab96c3001e1b3\",\"/knowledge-medium/src/utils/webLock.js\":\"207f649a00d12bf1\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"5f526b796db34a1c\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"1cdb7a6acf79bd8b\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"734c72df74a7a88f\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b9221a81d4974a0e\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"07d324653dfd7c11\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"872376420e38a0d7\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e0b24bf8c2484ffc\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"538ad5705484c011\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"68ce0c00d2c8eae1\",\"/knowledge-medium/src/vendor/react-dom.js\":\"7776e1abd3925eca\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"7274f6da952a44d0\",\"/knowledge-medium/src/vendor/react.js\":\"865832830bf76733\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
