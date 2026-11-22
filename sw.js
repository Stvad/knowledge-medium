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
		buildId: "170b9ae392cf-d8ad8a1a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"43bf8c32807f5add\",\"/knowledge-medium/index.html\":\"43bf8c32807f5add\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-C-Tv0Su_.js\":\"ab2c8d16a4a86e2d\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"7bfae037e6bc4c6e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-GlRGAHHz.js\":\"5a7c22d4432a9741\",\"/knowledge-medium/chunks/FacadeVFS-BkHtA1aj.js\":\"66c3cc71fcf2c19c\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BtYMbTMi.js\":\"c4b8974702cf0e13\",\"/knowledge-medium/chunks/MemoryVFS-8bjCwh66.js\":\"d5caa6cdea0ec1c9\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS--p_Lh6L8.js\":\"e047b3e92992b3b2\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CknO0fZE.js\":\"1078c722d81f0110\",\"/knowledge-medium/chunks/Preview-B7wufw_Q.js\":\"75142e9e85e3b7db\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Keml0N3o.js\":\"24b9577a9fdd7c24\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-B19Ds3yq.js\":\"cd8ab8ee326ac316\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-7Mf7xUfu.js\":\"c3652b0a7613855b\",\"/knowledge-medium/chunks/react-C0XKGP5c.js\":\"8eb726500742e702\",\"/knowledge-medium/chunks/react-C7c1PjJf.js\":\"f43ad213cf27aad6\",\"/knowledge-medium/chunks/react-CDPZF6on.js\":\"68caa237fa3cd4c8\",\"/knowledge-medium/chunks/react-CJeWksTU.js\":\"7173063fa014f199\",\"/knowledge-medium/chunks/react-DCQUpfu8.js\":\"3abf4e29290f5a21\",\"/knowledge-medium/chunks/react-DLJxV8m7.js\":\"a6d7356c6556b2d8\",\"/knowledge-medium/chunks/react-DkNT7HFo.js\":\"ea46eb7f0712d8b2\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DSOwDBNX.js\":\"bcdf23746189c901\",\"/knowledge-medium/chunks/react-dom-server.browser.production-5sFoPn05.js\":\"c9e817ba703f4d2b\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DUXHQQD5.js\":\"6f1830471873bf75\",\"/knowledge-medium/chunks/server.browser-UD8DjhU9.js\":\"1717b45bdca6bbab\",\"/knowledge-medium/chunks/textarea-DLvp9Pi7.js\":\"69412eee299fb47d\",\"/knowledge-medium/chunks/ui-Db4mA-lZ.js\":\"f05da94542f6e64c\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"210052b6c769f7f0\",\"/knowledge-medium/src/appUpdate.js\":\"213d46410bb094ca\",\"/knowledge-medium/src/appVersion.js\":\"057f705ebfb03a58\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"6ad907ccd92f7290\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"71067ab129331568\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"444e2c7f2e898af9\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"67198e46047c7f1b\",\"/knowledge-medium/src/components/BlockComponent.js\":\"5343566f833356ff\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"2ae8eacbf56ebec5\",\"/knowledge-medium/src/components/BlockEditor.js\":\"eae3b2580a84772b\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"a1e611610a3f7041\",\"/knowledge-medium/src/components/BlockProperties.js\":\"bca7c62fb0c5f978\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"e8a75a184503d061\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"09c9b0416ab5bf6f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"a7a5cf507248c207\",\"/knowledge-medium/src/components/DraftEditor.js\":\"f025cb3a1c46c351\",\"/knowledge-medium/src/components/GutterPill.js\":\"49d4134e88780eba\",\"/knowledge-medium/src/components/Header.js\":\"6bc18ac5b634dcb1\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"6202be4f8707aaf3\",\"/knowledge-medium/src/components/Login.js\":\"ad7e2c46badbedeb\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"de9a04837f92af42\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"92e7946feef0e6b9\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"acd19482a545bdbc\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3f1bbe83a898f8a1\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"ce623ab64e2904a8\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"4fde83bf19046c57\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"ef2fb341f8c6e82d\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"eec71b729695ff5e\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"f9de781186b13367\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"fd97294cf6f2d8d8\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"410bd84402399ec0\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"e128bec427447aa3\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"7d6d0f319879985d\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"95ca90b50ce686f7\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"ef289e401e790a94\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"450f3ceecab9227e\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"0564b499476fad63\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"8215bdb0726ea501\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"9508caa2e1510ff0\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"32f76f59353ff61b\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"66d1836dd437f847\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"4cbdc3bb958b0aea\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"89d71140cc33d52f\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"438ef8362896d58b\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"d96ae8c61a282666\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"1bca71a07d3ad2f8\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"d55ed8d0757257fd\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"eff04c1eddb1c231\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"28a8661eb438d530\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"9faddf3dff6cdb51\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"fcabdd0a5ff31ca6\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"832ac30f249d5dad\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"324c65a2d139d412\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"dc33dfa04729afc5\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"aacd53ac93073e7e\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"21f8bbf0ccd4bf66\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"e85908cb61e84f4b\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"2e41688fb5461db7\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"3e54bd9155f1674b\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"60b4f4b64ea99a65\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"8b2abc35691270f7\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"aacf4ccd83c718c8\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"df2c234ba1b1809d\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"880495071fa87ccf\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"a99acd00fa3d31f7\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"7e5239aaf51415a3\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"9d3f991bc40cd362\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0e815cb7ff42a6cc\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"9dc4742dca9d2258\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"7379ace8f8da989f\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"421fc94a04b45b99\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"306fc09643b2fa5f\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"fcd848a4ee10ca70\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"c87012f6cd67b8df\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"420ec3e155dd6317\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"dd26077a04c450a6\",\"/knowledge-medium/src/components/ui/button.js\":\"85417032b1ae742b\",\"/knowledge-medium/src/components/ui/card.js\":\"c61669433d8d4870\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"5d2d8f2b30b958bf\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"d0ce27c6a7052aa2\",\"/knowledge-medium/src/components/ui/command.js\":\"b6856b3763919302\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"0c2ea120f5beb7c9\",\"/knowledge-medium/src/components/ui/dialog.js\":\"3d40df1df6b531c5\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"a564a5dcf060c2f9\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"bff3581569f2395e\",\"/knowledge-medium/src/components/ui/index.js\":\"997fc150eb59c0ac\",\"/knowledge-medium/src/components/ui/input.js\":\"1e675e443de79e4c\",\"/knowledge-medium/src/components/ui/kbd.js\":\"a16b18ea052239f7\",\"/knowledge-medium/src/components/ui/label.js\":\"016c1707cfb8208f\",\"/knowledge-medium/src/components/ui/textarea.js\":\"fcf398a82938d026\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"13e280d22a8c01ed\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"23ac23d3b657e3f7\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"c20e8091a1c08823\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"f40f867c8cf3cffc\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"81433abdbc21f91f\",\"/knowledge-medium/src/components/util/error.js\":\"02cebe97ed929094\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"5b231fe9a903370d\",\"/knowledge-medium/src/components/util/suspense.js\":\"80e1da8aa8a5944d\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0a95bc8cbe1acca3\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"2cc1a5a8b214b34a\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"d0830d71115a2201\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"71113c49921a31f8\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"fd6d5f960a3ef1a5\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"6ba25c38e5aca62f\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"6d20f5b1bca8bc95\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"682baa94e70f8e23\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"0bde2c70a29f35f6\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"12a246c1a14abddc\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"228929b661c0fe2a\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"8b229db6009512a5\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b3e70c1d35f4fc6b\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"468673952f54dbe9\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"4275139635f388d3\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"734cfa465dc91218\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"c5e4836ed5e04a55\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"e13c18678172d6a6\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"465e7f65127389cb\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"7a6cacf80b8c7675\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b649e78e3fadb8a8\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"0b2f11f86a39e4a1\",\"/knowledge-medium/src/context/block.js\":\"bc2542c76568e526\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"4693c251354ddc3e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"0eb1e05acde0a9c3\",\"/knowledge-medium/src/context/repo.js\":\"8655bc488356e780\",\"/knowledge-medium/src/data/aliasClaim.js\":\"8d0cf60313a109a9\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"99c41dd846f467c9\",\"/knowledge-medium/src/data/api/blockData.js\":\"e941ff61b7122d86\",\"/knowledge-medium/src/data/api/blockType.js\":\"6409256aaf1fb8be\",\"/knowledge-medium/src/data/api/changeScope.js\":\"7f5424d6e100ec95\",\"/knowledge-medium/src/data/api/codecs.js\":\"652c44b184cd141d\",\"/knowledge-medium/src/data/api/derivedData.js\":\"90bb3651e1780f31\",\"/knowledge-medium/src/data/api/errors.js\":\"f46b321d9136af0a\",\"/knowledge-medium/src/data/api/events.js\":\"6d21e6b831911a49\",\"/knowledge-medium/src/data/api/handle.js\":\"e242ac94d558fe73\",\"/knowledge-medium/src/data/api/index.js\":\"fd3c878290e5f18b\",\"/knowledge-medium/src/data/api/mutator.js\":\"278b40a8943240b0\",\"/knowledge-medium/src/data/api/processor.js\":\"b5b43f0e2fc2016f\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"abd731383a34e871\",\"/knowledge-medium/src/data/api/query.js\":\"8c79cab048c85002\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"72b9843e34ce49e9\",\"/knowledge-medium/src/data/api/schema.js\":\"e242ac94d558fe73\",\"/knowledge-medium/src/data/api/tx.js\":\"e242ac94d558fe73\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"ef95be139626f6d0\",\"/knowledge-medium/src/data/api/user.js\":\"4210d95198793b2f\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"573a9ba57cee4576\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"7a9dd43996d94cdf\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"2ef8589978b7f840\",\"/knowledge-medium/src/data/block.js\":\"d11daeea6c6a0387\",\"/knowledge-medium/src/data/blockCache.js\":\"f396c21e3b2b0c00\",\"/knowledge-medium/src/data/blockId.js\":\"b1eafb2fda4fa984\",\"/knowledge-medium/src/data/blockLiveness.js\":\"337f7ce6aa549404\",\"/knowledge-medium/src/data/blockMerge.js\":\"6ea3afd016cacaba\",\"/knowledge-medium/src/data/blockSchema.js\":\"24b368a515c54d1a\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"a972909da4edca67\",\"/knowledge-medium/src/data/blockTypes.js\":\"e1a21be55cff31bf\",\"/knowledge-medium/src/data/clientContext.js\":\"9f0e61d9e4589c2e\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"b30541f4e02156d8\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"3a71cbe595efb9f8\",\"/knowledge-medium/src/data/derivedIds.js\":\"de4d2a89c440f9ca\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"63bac61a7b4fd7e8\",\"/knowledge-medium/src/data/facetBridge.js\":\"a07f8ca840bc1aae\",\"/knowledge-medium/src/data/facets.js\":\"f111e412b07ac764\",\"/knowledge-medium/src/data/globalState.js\":\"b935d45e261ce4ea\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"74061d7998835007\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"50d23d225a0ae71e\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"42aead82d9b35208\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"f38754f13740d6e9\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"dd0257c007023fa0\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"c1b65ffa176b693f\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"cc260d76c4962ec4\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"bb15c3cacc43c9a7\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"8ea2af19ce077c5f\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"800948cb3f007ff8\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"6e3edfa1510d8e79\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"b8869ac9f64840e2\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"5b76f7afc16b9e68\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"8556c3191b8608dd\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"6f886c1c2ade9f3c\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"1e552bf0a607ff20\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"fe00982075e02ac7\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"f433865b96d21f3c\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"8248e22b5916a1f8\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"1000c8bcda632395\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"43c4228ef91e30fb\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"a69fd65efe68e058\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"54534345c19c2227\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"d9439055ea2c886c\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d1b8a2c0780e2d68\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"d11c7fe1b559a9ce\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"02402ac8e3f42034\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"3b41df78d8d69a49\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"d6ae3b81a83bec97\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"d793066967e7df2c\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"e9a18626f8f65a50\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"274dcb8726d45439\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"88e2684ea84b0bce\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"994497efd81d3078\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"70843d3b30fa6669\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"e8bd89190f36b22c\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"96f1b7fa26cbcb9a\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"04a7a646c4d68dab\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e2b4c47c7b83d886\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"6e5abd9ecc56978a\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"8e4798c5f6c5bb3b\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"3085cc9924e65b40\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"5c370c7778865b70\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"6fd9f2d688296c06\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"fca1035a16d55a1a\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"7813bf19f3087439\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"5e56acdbde74e9bf\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"dc7817e07a3ff031\",\"/knowledge-medium/src/data/invalidation.js\":\"b5874e67b0693eb5\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"8edeebe7e6ced6fd\",\"/knowledge-medium/src/data/kernelPage.js\":\"a15b6c1be9e07ed4\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"9382d14eb2cc6f7e\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"7213b1895f5df799\",\"/knowledge-medium/src/data/localDbStorage.js\":\"92accf43865fd6eb\",\"/knowledge-medium/src/data/localDbVfs.js\":\"3aa0203dca4078e1\",\"/knowledge-medium/src/data/localSchema.js\":\"85b8331f590fbf47\",\"/knowledge-medium/src/data/maintenance.js\":\"ad08f87b1d180cb8\",\"/knowledge-medium/src/data/mergeProperties.js\":\"7ca4ccf987e2be34\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"901e2f85499e4baf\",\"/knowledge-medium/src/data/migrationsPage.js\":\"c76e0e7e6e93684c\",\"/knowledge-medium/src/data/mutators.js\":\"16c35c282dcb67d4\",\"/knowledge-medium/src/data/orderKey.js\":\"79a94d1f281c3638\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"82b622f0c845fdd6\",\"/knowledge-medium/src/data/outlineSurface.js\":\"270044af9cd90086\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"a40450bb57c66f91\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"cf053d6ea3f08dca\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"16b690c3aabb17c6\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"2620de68bbc0354e\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"ab8481e82d5a6554\",\"/knowledge-medium/src/data/properties.js\":\"635179bbbe7283b1\",\"/knowledge-medium/src/data/propertiesPage.js\":\"906a540dffc8a630\",\"/knowledge-medium/src/data/propertyChildren.js\":\"93c32cf5878a876f\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"616c815e68166d7d\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"00251771d136d432\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"ad1cd2a5fdd4d58f\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"aef626988ae1aa81\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"b63bf75d9a8650ff\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"0e1e8d17140ea8b4\",\"/knowledge-medium/src/data/propertySeeds.js\":\"4b096397302f2799\",\"/knowledge-medium/src/data/recentsPage.js\":\"d2759eda80aa758f\",\"/knowledge-medium/src/data/referenceBlock.js\":\"f197fec7f558849b\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"7685ef310b423bc7\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"e89a30a556f3a410\",\"/knowledge-medium/src/data/repo.js\":\"bdf66c567f407a8c\",\"/knowledge-medium/src/data/repoProvider.js\":\"5298eda17be1e56a\",\"/knowledge-medium/src/data/rowProperty.js\":\"cd40ecb6b9816a6c\",\"/knowledge-medium/src/data/searchFilter.js\":\"a89e4fea46739944\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"5539e8ba7a133813\",\"/knowledge-medium/src/data/stateBlocks.js\":\"2dd0756a3035e1e9\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"b36af3a10077ae02\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"ac60239caf4c2d13\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"78a22818f51c239e\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"5fcb33e03faf686d\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"88e2ffe4920d4a59\",\"/knowledge-medium/src/data/targets.js\":\"0e0f1ec832a2a38f\",\"/knowledge-medium/src/data/typeColors.js\":\"196bee518e96daf3\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"3d2dda5ace2ff5e6\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"5dd0918005debdc1\",\"/knowledge-medium/src/data/typeExtraction.js\":\"1aeb2a70d1cb51f8\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"8ee4d2a399347b93\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"faaec73b246658f5\",\"/knowledge-medium/src/data/typeSeeds.js\":\"6182c6f81d5d94d4\",\"/knowledge-medium/src/data/typeTagger.js\":\"1bd5ae6cd30faffe\",\"/knowledge-medium/src/data/typedRecords.js\":\"395d66302b83f6ad\",\"/knowledge-medium/src/data/typesPage.js\":\"e649e51ddf9f58f7\",\"/knowledge-medium/src/data/userPrefs.js\":\"eae3be44a6c325b5\",\"/knowledge-medium/src/data/userSchemasService.js\":\"d6eca81afea83f33\",\"/knowledge-medium/src/data/userTypesService.js\":\"363ca43a2ae335de\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"b080aab4d5741c47\",\"/knowledge-medium/src/data/visibleChildren.js\":\"748a10c94c140ff8\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"e2dfc3be07169869\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"a72dc06c58695fdd\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"e32db8c00e464c72\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"1427921980d45c0c\",\"/knowledge-medium/src/data/workspaces.js\":\"7e26b66843d06c9d\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"8b7244b2c563aa22\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"7d073a6314815699\",\"/knowledge-medium/src/editor/atTrigger.js\":\"00f18e7dc252f15e\",\"/knowledge-medium/src/editor/autocomplete.js\":\"628e304f4a87a8dd\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"cb8459f12cfc6f76\",\"/knowledge-medium/src/editor/contentFlush.js\":\"3650adc2e199b988\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"4dbf3ac2710c6371\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"00170696ca0ed54d\",\"/knowledge-medium/src/editor/insertImage.js\":\"138b4970ec770580\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"6b67b78c365e979c\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"cbae8e9b0be55bee\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"1332007722706cfd\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"d05045a292afe182\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"4b569bacb160fa07\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"574b09caf43aac26\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"1b90ae5f388b2b66\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"f50cbfac5a4f0c87\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"c731a4d1d886632f\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"dd9572c4b026df43\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"00364f127dae190c\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"f0f6c0dc3c654fce\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"f8837528b4bdd8aa\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"67c2a55410a2afe1\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"ed7f8d125863904e\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"846de838ca986950\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"5e79d4fb85f9ed21\",\"/knowledge-medium/src/extensions/core.js\":\"5f4a7d9b833d86a4\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"6f8a6a1ecc3aeb46\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"8902e430f6132439\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"67da97d27968e624\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"b1e5ed77f7a051fb\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"352e881a5f8cc389\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"2227b07d4ee5ac22\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"a734f191225e3c4d\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"349121a18fc88373\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"72787e5d5f268430\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"38b2d5e758614afb\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"d1fe26b4ef1baf0f\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"685ca7357ef4c8a0\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"58fd27f5734da93a\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"2487dfe452355587\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"bd967b134414d19d\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"6a3841f669ba9932\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"63af5faf42c11c76\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"3af5d99d78268373\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"0b76388420d623c4\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"142f62fb3a19bdd6\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"2893636b9239ba84\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"9b2828c03db99a32\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"37ec918f1ad2e989\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"430179313d581c7d\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"2300beced31bae47\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"caeeb8900dc28e43\",\"/knowledge-medium/src/facets/facet.js\":\"366fa069b69523bf\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"3bb85871cc3bc2e8\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"f60db168bfa8fd07\",\"/knowledge-medium/src/facets/togglable.js\":\"a1ed3059b5b38e85\",\"/knowledge-medium/src/facets/variantFacet.js\":\"dfec495679663350\",\"/knowledge-medium/src/facets/verbFacet.js\":\"f3d28df144bd8d85\",\"/knowledge-medium/src/hooks/block.js\":\"14ef20f0e90e199b\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"a980a0ff26700754\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"c8c120de2446fda5\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"5127a063947cdc67\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"4d0064c1f5e51f11\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"5db2535097af8e96\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"c9d21478c28d9b20\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"dc0a7c97cabeaea4\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"516232a4c32af0ed\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"491972b64c1f44f6\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"20838533ab91d2d1\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"770c5b8bc85cdbd7\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"75ba912efaa0041c\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"6332c7d4e6058871\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"46f2f3482b817e6a\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"f3a49ce89c78abc9\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"174dbcd7488a4aa2\",\"/knowledge-medium/src/lib/utils.js\":\"9cea57e4c7d641c3\",\"/knowledge-medium/src/main.js\":\"8e8135dd687b4065\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"4221928e7d040945\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"91a941e1d8fcf13f\",\"/knowledge-medium/src/markdown/context.js\":\"1447f5756fc91e06\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"a5be718ed6b38634\",\"/knowledge-medium/src/markdown/extensions.js\":\"7f2cebd99e782899\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"7ec40228be8cc67b\",\"/knowledge-medium/src/minimal-editor.js\":\"e55884b81a5007b8\",\"/knowledge-medium/src/paste/armedCut.js\":\"17f2e94b291893d8\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"b1424abdf041e9cc\",\"/knowledge-medium/src/paste/clipboard.js\":\"291598b99f8551e0\",\"/knowledge-medium/src/paste/decision.js\":\"cdeb12b3fc3fe4f5\",\"/knowledge-medium/src/paste/operations.js\":\"d454d1f8e7a67596\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"1641ffdf59e6781d\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"b01a9870982d7c31\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"26a85974271d9ec6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"43e6ec3a0bff4d4a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"eefe95a0f875666e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"223ef9432b9940d0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"8a31010a1743d75b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"79a4900d11bae92e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"c2fe14c98c8d7286\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"86697093c19a16a4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"466721e32494140b\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0c25e02df7e667ac\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ca872bbf665f3488\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"6862139a4725841f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"df61788904ecef13\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"4991f57869c4d74f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"6b2e588e26ce4392\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0fc88459bd9efb1f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"89a9a396688d0d06\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"55c4478ac08a8fe2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"557487b6e3b666df\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"e767ce0f5725161e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6cfe44a84ea3b61b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"e046c82f82d951ba\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"2e2f0b48a2efbdfb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e210842448c35a48\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"64045eb598780bdc\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"25ee8c3cd1d3ebf7\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"89f0d3372e09aeb5\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"12c5fbab5765c247\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"42882fe524e7d3c8\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"d5e59148385bb868\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"8b61e93822e52a92\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"5d35aa910a14f482\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"9bfb459a44c22041\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"45437c4f7e9810c0\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"576bc7534aefb8be\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"b3e0ff35380f1251\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"613eafc1bb82b9ed\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"6b32654eb18c53c7\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"281f00875f5651a2\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"96c6b7ca18366a35\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"9535e515355a15b5\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"49ed894fc89dbc0c\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"5e7612957151c441\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"4bc6cbc70495063c\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"0e01d31658a6df30\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"237bbbeaef4d639f\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"a1fd40b56d6c63cc\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"36e02eb0fe9f98be\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"527fb20dac573a05\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"63c31d58bbf9f2e9\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"1472bb52cb576d19\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"607acad86df9cecf\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"7fefa4e6ad4b54cb\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"49865257f5f7f02e\",\"/knowledge-medium/src/plugins/alias/index.js\":\"7f14118b3725540a\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"7db350ba780cf5ec\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"f500adee798ce7ed\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"c9370d748f54c3fb\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"0d5c4b79bb09bd91\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"947c486603ea8540\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"3b73b28295a09d46\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"72a7181e114114b5\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"65dccb32201cddd4\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"6234b4af8e06ca6d\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"23a83ae3e708e8db\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"5bfbc70358cec139\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"afc02f4a63e7d3ef\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"da8c5d770f810b6f\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"08ad73ad88d851c7\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"91586cc6f35d0f9d\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"2e593454fd9a52de\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"259424bd39c9e1de\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"45060fae889bc2f0\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"70a122eb99dfb997\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"c28703d559ea3d20\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"41417e8286f15664\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"fcc3212e52af649c\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"87dd7abf84ea923e\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"99d389f19f06faeb\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"68536402fb1fc15b\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"ebafee1a54207054\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"1d4ed33266b068d9\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"dff14a55d4c0706b\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"bd36af70b90e686b\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"8ea86e584b5a4e73\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"f1e093760924ee67\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"c8ae841cf9546e22\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"2616535463f31626\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"0e9e8bbdd0e1a047\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"11d971193a0716bf\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"52a22b648002ac4b\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"f6eb547eaf7a0966\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"61d6934a7b4b64c5\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"821848405c87a1f3\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"43ae1bc0cc61bb7d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"7a4136c7c7cda229\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"97dc324e33878858\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"f11999f0600d244b\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"04762d3e0513c404\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"20b244cc5d8e56f7\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"602403eef45a4dca\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"437e47e518965392\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"30acd3e6ea4e1818\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"ae4f865bd5c8ed49\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"187f5a6caff39651\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"ae9f512080516d26\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"5ca132703bdd83cb\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"36fa9efc377aa944\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"81182a910674d702\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"4e14b4310d34fc0c\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"de099dadc39cdf05\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"51caeb1e32566f3a\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"24f794f56c970be5\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"2d0f5fe69c2adbeb\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"cce3e247799a11ef\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"be1b846d3ec8f118\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"c3e78ab8929cdcf3\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"1e3a52c735188909\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"9cc3f1ca70073f5a\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"468c70034dbaa287\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"bd6d14128f75efb3\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"cb34598f08fa8474\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"858160d94506d573\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"fef7613918b5c959\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"08423d7e24f6bf35\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"5733f51d708b0e31\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"e397ea590a1638df\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"ea43952218239048\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"40bcacc25510ad11\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"c84509443d5185a9\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"cf095408946fbbb9\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"99d441e267b12357\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"c51460b8e9cd2746\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"6ef7d65f47815780\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"8e405582e43a9c99\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"665ec56c0bea87e9\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"82b290470a64f9a5\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"4d84a01fb9fd3b31\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"ee3e8b71a4f802dc\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"8790ea1304e12998\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"c730b0885f0bb5aa\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2cb9cd23f87b5322\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"ec0385960cf97dc5\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"39e3df4f6c68af65\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"17027bbcef5a1c3f\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"b8296bb6b5bfd700\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"71ae85b048d4ca47\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"57071bf6d18e87aa\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"ce87ee6e7501af99\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"edba233c69e77045\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7e15e5bd3c1dee92\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"b2f6359f38ed649e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"6307dd1179a6397f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3a7b855b5d47db91\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"8047003542348b43\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c4a86eba7bcf7683\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"9a6879b777ccc00b\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"3a740b785a26e8db\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"0a4329b76516dcac\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"e319b5a5c5d6e312\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"8e219dbbd3e9c4ac\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"4c778b8d5ed63f05\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"08440f807924686c\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"e7668ffb58439699\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e573af449ae209f2\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"a7c005ba179241f3\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"bc11e4bb3a2791ea\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"c090d18f6918ee71\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"bcfaf5ce51c996ea\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"922194c891d2fd28\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"ef6301e601c468b0\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"8131ace9390b8dd1\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"8abf705e2951ad2a\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"ffc37420e4534ece\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"53633845000fd459\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"1f707e2ab4206eb2\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"42445d12aca767f9\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"e6c6512bd4c3e7ae\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"22915f6dcf71d52c\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"ffcc5644f00b909e\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"0d1e41263971be31\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"fad692619cd9ad14\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"340692c43f99449f\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"c908215587167814\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"3c61ddcd127a70c0\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"3fdbffd61cd3ec30\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3c6d0e8e9cc53f3c\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2e091e7816277e56\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8474df34e59d8eb3\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d09187ffd5bdccd6\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e197c9da860e6bf6\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"a7d483021a0b91ca\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"77095cfed0626ab2\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"19d2125426382704\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"284a29c04488daed\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"3ec6ed173c901d4b\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"3c481e9481ac8946\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"4b64ccb372d3626e\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"078a32de7dd8b481\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"8daeb0b5cce3b8d5\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"e1b5235be34529ab\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"79d71f61c79caa6f\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"783aeeddfe7e8d2d\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"9090551eeb1f61fe\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"d478a8ff7a269cfd\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"7ef41dee2fc521f9\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"811183446635c1f4\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"e3a8730fbb618c82\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"e8f6c4158b75a7ac\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"f78d10884a27bc39\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"8638720318b344a9\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"f634c1cca655288e\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"b1c2ea0b7c8cc26e\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"269cffe4334dcef6\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"c2d8e44fe20f0ab0\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"41771cb83bf6eaca\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"ea5b556bc16b5246\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"ed165986eb5a724f\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"5f429603441fab3a\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"24b5d5ef2006490a\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"a0c4cee88dcdeca2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ec5f53917abfd909\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6b27b2b94a46647a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"b86e19d6a0595963\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"93b3462483032c22\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9c54cae928c848eb\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"4e33e72a728a1a28\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"a561a1c3e4ae160e\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"57a447a7a1bd9d1a\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"95478f60c7103f27\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"4b478a989e2fbfb8\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"664b7c0a61d99a4a\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"8340978d1bf94814\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d411fcd49f1b2c4c\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"c585deb02f67ea4a\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"00c28d4e96486be8\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"ea8231393d0c0c05\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"daeefe83d94b62e9\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"e7c722ce1b9fa186\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"d693dcd8e02f9104\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"54caa3f98003beee\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1b9fcfcfd7d9e0d3\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e83316930aa9ecfc\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"f997a4186df33052\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"ff3a80c206c5685e\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"b0dbcf0fc44fa1c6\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"9a9d7c74e9a190c5\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2b05daf965acb446\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"04ae001731d08cd7\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"88e374e5cd44e8ea\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"5ecc5ee387a149b0\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"a069656dbe107060\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"3b4a8af9889dbd13\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"0eb55110236bbb23\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"91bc1905686e10f5\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ef0fa1912a065741\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"28e1d2d28ca0c6d8\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"fdf32e3652ea63d3\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"c98e887dd2b49546\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"f27d9e6899721211\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"2c9915e7bbd64ba3\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"3f3cec1246110992\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e99f2c5819d7364b\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"a129766e4f38a00d\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"731f7d170ae656c8\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"363faab83bfd68d8\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"f7c867ba29f528bc\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"e08d1d3770ba9977\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"62362e0518765ac0\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"60d963596ec704a2\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fd2cba9f5c0700ed\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"4921fba14457a183\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"0b1430dd779bd232\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"99e85a5e9693c9b4\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"0b4f5b1695437099\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"7411b4948c6a1320\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"5356e05210173245\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"2a030d0b0543e1ac\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"7702c598df4427a6\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"b9379821011f2b3f\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"ab8ae84095493d58\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"c3b2dd774e95f34f\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"06059caf8f92d7cc\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"495c4417fa046685\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"03ad27f085efe849\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"8af6e9a9c473ed31\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"ea68d6f578f4aabf\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"93e5538aa838c4ea\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"2644a8e7d06c0f13\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"52456ae50e7ca212\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c2d69c8fce6ca7f5\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"560ed5072f573f87\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"a36368b132e3037a\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"b887bbde688e2870\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"49a766a84e189c63\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"c76506b7fa1b952f\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"6399cfa797f3ec29\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ac1a3f7b80ab9ae7\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"0a3c3a36b859d5aa\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"f6eb2de1080eefe9\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"abcb9bd972eac694\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"10baaf11105f25cd\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"f8aedc26abbe78b0\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"1647b91986f1d393\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"0e7296d9a43fc179\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"5d59e6de5683b39b\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"11d09fc3d374a9de\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"79358b80a37d90bb\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"84d470c6d0455f02\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"99bd4d30cf477aba\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"d1e66b1a2081cdc1\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"17e395fd6ad5c58e\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"53660d066a9dae1b\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"f6f95fc4c4f975da\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"91f88eec43f938c9\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"e94734c375e0c762\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"f69c39363e6631e9\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"16906e4d6b336189\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"e6c1fb9b10797e15\",\"/knowledge-medium/src/plugins/geo/index.js\":\"98794b989b15b79a\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"1dd9e433e8434693\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"aff20c99921ea4fd\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"e395a8d3bf5cc01d\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"1fe25c55c8bbb1d2\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"2577d8af3409bcb3\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"67205383f8a42da8\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"87291bacd18eeef6\",\"/knowledge-medium/src/plugins/geo/query.js\":\"25b02c6d0bcab574\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"97efcddb8b88af0a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"fc96e9b49b41b599\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"afa33233dc24de88\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a02789506ffaaa70\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"14e28785f7fd9775\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"cdebaa272bf82d62\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"7c47a5a1b696131c\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"957812a051ad44c7\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"297a512585e5b75a\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"09aecd42a9b1bb35\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"e1dceeea80215f9e\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"02c9f0bb1a57f1d2\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fd5795091e6b9c9c\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a25c16e8da162d31\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"190bfda8c8441d0e\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"3532320e75c12166\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"392ef20267dc6f21\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"2442b8b531a2df97\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"c8587d309fb8e36a\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"3273b3a1e120c08a\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"531fa2159c3a878f\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"7c729291a71be289\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"02b539a72d3df611\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b0995331eebf06cd\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"220f6121f0879760\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"5270d7f299796637\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"b63642e7b7925a8a\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"426b370a65109f92\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"6b76481aa90d7e63\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7a4ab91264ef01b1\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"55b29c3897edf7fc\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"7b029482b997d36a\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"06bb11f2960510d6\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b902ae90e1309458\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"88d3de189c2806eb\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"97554dbcd3d5488c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"b331e9e2d969fd44\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"d2a5125ad8b71e46\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"b124b5a818bd603b\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"95fb97a8c20a0d81\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"e9d7d555d7156e58\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"8f85d3446d6fafa4\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"01c7ecece9a4f868\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"bb3f9e5ee248d2fc\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"c257a79bbf0fcaa6\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"27e9e647b7aba262\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"53ee1ed9c3717ae4\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"27cfd16edd61ceb7\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"69b90244cf4f545e\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"5989d393ee32043b\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"ae69e3f0376c7208\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"cf2327a8cabff728\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"87c697bbde8bf2fd\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"a13d72f94553fce1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"051edc92de324912\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0fcb754082a01b9b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7d60c844d7ac9e08\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"cc3a44ed16addf92\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"8aeede0b850fb429\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f7ebe3dbc66e1696\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"45c71b1d5fb17bd3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3e0e9768dccf4008\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"89b6ffd57a94bedd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"b63c7ad40ead32b5\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"85dd25a9fc1aaad6\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f400d935d7b63752\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"bee00cf8ad84c3ef\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"3ea8ff9a90b14f85\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"2d30d71128e578e2\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"f4e73abc7bd9ecd5\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"01ace5e24e4bc5ea\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"51b1c705a9a475b4\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"01034aa359235f92\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"5d7b4ed420e3b3a6\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"e0e758933883384a\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"dfe5ed09a5b75be4\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"f9df38b77a8cdfb8\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"4829855276e57b9c\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"71be2925ed9b7bc7\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"d1fd8e6e02d22b6d\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"99d56c623d74f587\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"a71d4ef0454e1f34\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"55918dd921ced114\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"ae69cf6400c2671f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"868ec833e68a909c\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"553e2cd13850130e\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"e45455e739faabd9\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"2d4b30e413ab9f72\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"d7482fce9263ee11\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"92f05a3f761a01c8\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"42dc190ecedeccc0\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"1e9f41d78bcb63bf\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"738442432043bb4e\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"a7043ac6dc01d267\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"6e06a79756b6781f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"41976a23d44dbd43\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"681b036edce2f47e\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"f278f3d7ff5555d2\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"1f897c96f35f4cd9\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"888fe6e5faefa077\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"5490bead6e6eac7b\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"85cf5642e58ac2e5\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"a0220a97ebabd9c2\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"502c4514b95f9b6e\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"090b18d947f8cf7d\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"829926b2038a2c4a\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"308a60fdf7143c4a\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"964575c73e4fabff\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"d9eb5ddac41103ec\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"a2e82b5d3d880d15\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"a2667f97a6c5f2e5\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"d88139a4848331e4\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"3a55cc205c33bdef\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"b8f9ffb71c335ff2\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"a81ab72e53bebb56\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"a74ee15a902489fb\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"fb19df538645b46e\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"acbbcd667605db4d\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"00c831cbec8f0d12\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"f1b3e7320fb2eec3\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d3cdbe828fe9da41\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"ceb9678979920622\",\"/knowledge-medium/src/plugins/recents/index.js\":\"edf28e67a50e3005\",\"/knowledge-medium/src/plugins/recents/target.js\":\"5dcad02bcbe5ca73\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"c21a36ce1b94c34d\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"5f8df9754b8ba4e0\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"931dde2e608c4365\",\"/knowledge-medium/src/plugins/references/index.js\":\"56cfb529920a2768\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"db0963ad7e284e39\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"abbbde36d65db962\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"47b57d683f4a7cce\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"eeff09779dafa348\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"aa9fe3c043ddcd9e\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"17fc1d010a7a8abc\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"250000037e994236\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"9858f95488fed518\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"2c126d66d1b2e698\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"50f89624c9598235\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b3964bf87f316122\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"da0c59b6e20e729f\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"849dbc6bdd0a2dcd\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"8d151fb0a08b9228\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"c055af318b9a81c6\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"8aced2ffc1c635e3\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"2d3594b7b28b0534\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"4874b596ba8c9cc8\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"0fe51a7c76577503\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"fcc16804de09b181\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"65e5c87eea3ee9f6\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"33401baafb2141d9\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"113556d3a1b522d7\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"e68574156599a2cc\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"0c9ab8481ebe9c89\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"a732672b272dc826\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"b5c50f8ad6ad652e\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"daa1a7c7560547e2\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"bc3bcebef79834c6\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"43f0d2f9214a90bb\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"0d5695f464068d21\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"35a7775a5b2e3f60\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"2ce271d5cd924c1c\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"e11d8411c3093ffc\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"431f62610ad5d571\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"4273f5f78ae4727f\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"ce4b3bb859cb6721\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"91cae887ce6ed457\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"8cdafd022eabe509\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"be90a41e97253e27\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"ff4283c35688a65a\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"15daffc4cf5aecd3\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"81a8d11b19c9f8e6\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"fc4ebd6b105c9ab7\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"f6598d90ee752c27\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"cb765f47916bc87d\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5605b0cb07b21159\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"812ea4437067903d\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"431a89df1cc0641c\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"470b684836898060\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"457e14b029aaee96\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"cc6ddb07455c3a24\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"12d9a9af9c43ca6e\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"28b11ccb4d9c1437\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b0a8de76c3c24c1f\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"a789177d7dc7facc\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"70670c30528be4a5\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"d711d6e74c0b6428\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"9ac1b6b13eba9cc1\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a032529440fc9643\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"f017f4b479d46022\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"eb935c536710e5e7\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"53879efc1690052b\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"6e489e5834228bc1\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"97827c2a8363746c\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"ce95cb751e6af719\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"09eb3effe540200d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8ff296ec37445159\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"83198836adc78835\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4fad8cb14ccac39b\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"79dc5dbf30c06eac\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"19a9152fb483cf14\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"4064d4686de6547b\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"48a5d9158209b122\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"6be51c5e115fe9c9\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"078e100195476bc4\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"d8ec7a9cbdfa5be6\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"ef527122dc85ca0d\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"64230179715cbd15\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"e5a86df36a6f73bb\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"e393f907c6141acb\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"8ae748c8781b7099\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"840864cee622033c\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"9a3cb4419813823d\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"4ffaeb9228a0c8e9\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"a1ce6c423198ca97\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"7ccd67d46f40b64d\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"69a0eff48b6b725b\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"51ee3903650b4fe0\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"2f048da205358a1f\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"48d2bb51d5e900f9\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"6adb4c3346020828\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"2ebf485cf67ca354\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"827b0f88ec81de98\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"0c81cc24d69427fd\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"80c77ddc5af4b4e6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8c38676325af297d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"e0851506a3c6d650\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"4af718af55e494cc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"21436065461dfe8e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"f0709811e3403034\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"d7101ccc73a2fff0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"29de06dcd36d8581\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"cfb40a50ff8a9a2e\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"51ed871784d57cc8\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"315a4d1f8e5f9444\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"968fb65cdeaa17ad\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5168ee5c7970e3c3\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"d999ac59b2f8b897\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"9f74e7d660ddff92\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"f0fa24794481c9f0\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"1912f2e3752f9fc3\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"93969dddb8aaf9db\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"e8305f06b280b263\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"5f399344fdec596b\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"843e4efd3a3a6faa\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"fb9c8357a466ef1e\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"3e48814e4bbef9be\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"619504d2d654b83f\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"93c7c7170b1421f5\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"c4b5a8698e407d9e\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"472552e692cc982c\",\"/knowledge-medium/src/plugins/tables/index.js\":\"3dd16483a2dcf7e3\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"af17742d34484bb5\",\"/knowledge-medium/src/plugins/tables/model.js\":\"bda7936c2bafe196\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"a7881d1405a85fc8\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"1445bccf8ea5b5dc\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"f0c0fbad183f2aa0\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"c8ea8264667bf830\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"db728a6bd0425eb9\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"2cabc198ebd2993b\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"b6e56c93a85b835f\",\"/knowledge-medium/src/plugins/todo/index.js\":\"f70a8be6df792241\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"d113810bf06ba40e\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"49dc59e1b07e600c\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"a47b03a46250de41\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"6c7bd5859c527fb3\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"3c503cd6772ac859\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"7258a81190ddf2fe\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"b404503667485691\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"c17d28651d284f2e\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"cc87003ca885a70f\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"8d0f446fd735e4c6\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"bd696169093d395d\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"67234cb1e7d68de9\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"7c97ab3498172784\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"3c2b53f75bdce7c8\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"a7ae0ef50f521fd8\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"e484f0e2a49aafed\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"9640484151b4ca11\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"406cfd0a53d32e20\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"56419e8a2a39caf1\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"e82a9d548a3b7c64\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"44db7cf809739d13\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"77644569d1d7ef0c\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"7041266cbe3fb5e9\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"6748bbb2b73ccc64\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"926038b39b523c70\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"daaa29664ddc4394\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"b36c6b98e8df1cbc\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"f3003a0801ca244b\",\"/knowledge-medium/src/registerServiceWorker.js\":\"f73702ff01800158\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"22e7a7be53952083\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"b10ac54352edffcc\",\"/knowledge-medium/src/services/authStorage.js\":\"41b834d2bd2cc7c2\",\"/knowledge-medium/src/services/powersync.js\":\"bf094d11c2396496\",\"/knowledge-medium/src/services/supabase.js\":\"afaa5907e7d03035\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"dd03a1193fcfd343\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"f4fb9d607c3d21e5\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"9acd84488e507d58\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"412e735c12de2cc2\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"cff8d1b824fa03ef\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"c5deef6d881dc5e3\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"b65aac0a9eef9454\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"bf5f0ca85628514b\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"6cb96b05818c70b1\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"70bd5aca576e27a2\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"a986724972f575a4\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"bddc047510957112\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"166eacbb098f8127\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"4dda5fe8fbb89668\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"e3f34630d6a758d0\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"527744e6fb9e01ed\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"8cbfe2f9c24c0972\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"d1557ccfde5630f0\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"cf4d0268ee242db0\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"dbc8f8a59b259e3f\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"ebf23ebc5e058497\",\"/knowledge-medium/src/shortcuts/types.js\":\"d9ca2d6017e46dc8\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"7431fe7dca7e724e\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"21b5d916a39371c4\",\"/knowledge-medium/src/shortcuts/utils.js\":\"9ac62d0c8d406d4b\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"2fe8fb40f78da877\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"af8fde708f6b5138\",\"/knowledge-medium/src/sync/byteTransform.js\":\"e3c8fbbf8c697e42\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"c19b8e6c28cf1759\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"d8afc6255839d28e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"25cf81c7e818523a\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"92aa379a311fe7ed\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b923c8b77c4fcf41\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"294018f9284e6795\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"1a07dfdea6333214\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"ceba670d34d8ea7a\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"5dcab57ad1607158\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"f7383de0b7c30a7c\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"268a3a0a86008932\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"31820749db8c86de\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"87ebdcf25b882588\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"fb96f0705d788f31\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"94537f0e03fa4ef9\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"3a77ce601a4160c5\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"17848b744f1ef828\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"7528103946c7b34c\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"32234ab211a1b6a9\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"dbd65dac446fb82c\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"690ba563d18d14d8\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"c36feead94ca003c\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"3f131fefbf8ae0b0\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"2d6ad85ac2903f84\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"9194956dd5dbf4c3\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"aae7b6f521c0024c\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"40d7fab44bec3bb2\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"cff9210262394c02\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"d35a6eebcf0384e1\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"70fc89c591bd957a\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"b44e9b138d31a562\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"bf5f0155853e9afb\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"53b6ba2e1a74cf69\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"1e95b26354586da0\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"c74dd4d2fa0544ef\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"0eeafd41e4ee14d0\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4d769cfcda145e4f\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"b6e6078de3317fc5\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2b801ba9f3a3c6fa\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"4caefa0b37100272\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"fd2f7c66179ae9ad\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"3a9aa2ca96c7ce65\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"d0daf25d424305c6\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"880b96929ff33420\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"4c1d1f727658ebcc\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"04a65b6f0d29c7df\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"5fe3cde783744fb6\",\"/knowledge-medium/src/sync/transform.js\":\"03df330f5cc6490b\",\"/knowledge-medium/src/themeBootDefaults.js\":\"47a61f3d0f5160a2\",\"/knowledge-medium/src/types.js\":\"6ef9dce18882392c\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"5f26bd9232af5cfd\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"d8b1d978f2ded94c\",\"/knowledge-medium/src/utils/array.js\":\"d2b79aeed1dc8dea\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"6d664835e8989e3a\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"5c7127800cdfc32c\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"6a90564de8c59baf\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"8f95f32650dd3fb4\",\"/knowledge-medium/src/utils/callbackSet.js\":\"8cba1b3bf6beca97\",\"/knowledge-medium/src/utils/clientId.js\":\"4d5c930b26ee69b9\",\"/knowledge-medium/src/utils/codemirror.js\":\"524e6307f7b71208\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"1b0a4d06170972b5\",\"/knowledge-medium/src/utils/copy.js\":\"8f1bc245739fd16b\",\"/knowledge-medium/src/utils/dailyPage.js\":\"aed6a040d999e106\",\"/knowledge-medium/src/utils/dbForensics.js\":\"f2aa0ec476b1e9c0\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"fd88c585565b1cd5\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"6da6d3d1d95db016\",\"/knowledge-medium/src/utils/dialogs.js\":\"989159678867659f\",\"/knowledge-medium/src/utils/dom.js\":\"c800c634973f74b7\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"5826aa2e36577a0b\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"e04dba8ce49604ce\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"959d3502bfc32d6f\",\"/knowledge-medium/src/utils/flipSlide.js\":\"0fcd6decaba6b724\",\"/knowledge-medium/src/utils/fnv1a.js\":\"c6a6352fa6a0170c\",\"/knowledge-medium/src/utils/formatBytes.js\":\"c557a2f3fe468a6d\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"b22f325e2e699e69\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"94ab0e3a51e93c69\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"040cd968ca780892\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"b3ef78db3d6a0bf0\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f82c526ffef57a89\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"6b06f0055d4beb5b\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"8e6406d9b31f1402\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"267cfcecc2fb105b\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"5be3c754ba6ec66d\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"e27e62cc868ee8d0\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"632b922b9f591f7d\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"e4d1fb8503bf6dc0\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"6b33562b1fae3546\",\"/knowledge-medium/src/utils/markdownParser.js\":\"ff47377e712d5bc7\",\"/knowledge-medium/src/utils/memoize.js\":\"ac02274d4aa08b50\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"ffcb8469c982783d\",\"/knowledge-medium/src/utils/nameList.js\":\"8e49856ac586c754\",\"/knowledge-medium/src/utils/navigation.js\":\"de9186de65f29987\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"4dfba457068776d3\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"0602206450a5fa56\",\"/knowledge-medium/src/utils/panelClearance.js\":\"8081727960a9dd38\",\"/knowledge-medium/src/utils/panelHistory.js\":\"99eed957d128b3a7\",\"/knowledge-medium/src/utils/panelLanes.js\":\"3f015565d9a0ae12\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"a46f7b08e6aa2672\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"8a851057b2a054a7\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"8e48be1274ad5f02\",\"/knowledge-medium/src/utils/platform.js\":\"b1c94dbf9b4b6981\",\"/knowledge-medium/src/utils/pluralize.js\":\"3c7b657e8e7d3c82\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"47593f4d7e684e86\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"8295335b44ea8672\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"9c67c15019548bd8\",\"/knowledge-medium/src/utils/react.js\":\"0eb70207e6d3de2a\",\"/knowledge-medium/src/utils/relativeDate.js\":\"8aad438403200cde\",\"/knowledge-medium/src/utils/relativeTime.js\":\"61dc99564aae9bd0\",\"/knowledge-medium/src/utils/renderScope.js\":\"830c2f73ec93aa9d\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"e2b2f4c91f354873\",\"/knowledge-medium/src/utils/routing.js\":\"7125231feec03fdd\",\"/knowledge-medium/src/utils/safeMode.js\":\"0840bd14d52eb97a\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"088fec4e6ca7b10c\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"2d9118ebaad63ab2\",\"/knowledge-medium/src/utils/selection.js\":\"127410b7245874d2\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"6b490e13314b4d20\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"8e1ea47ffaae9f8c\",\"/knowledge-medium/src/utils/state.js\":\"e9ca89839abf82c6\",\"/knowledge-medium/src/utils/string.js\":\"2d383f1db4314270\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"3f91a37c986aed3d\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"c54e24f79c4ef140\",\"/knowledge-medium/src/utils/toast.js\":\"588dc2d33e7dfb7d\",\"/knowledge-medium/src/utils/toggleStore.js\":\"64819aeb2c5a151b\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"2e562bb89284437b\",\"/knowledge-medium/src/utils/userActivity.js\":\"00ad4f5046205e45\",\"/knowledge-medium/src/utils/viewTransition.js\":\"7b37cfad65dde87f\",\"/knowledge-medium/src/utils/viewport.js\":\"9199dca8d298a442\",\"/knowledge-medium/src/utils/webLock.js\":\"f2187ef8fa6f47ee\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"80a91b8bb3420b28\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"2238effeb5c3f76a\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"6bfc3d4223121c80\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"d1476ccaff988ac0\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"814c4d15e3695e84\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"25ef0230aba2a31d\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"259999d17eb134d8\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"cf6b9ca98cf8ffdf\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"7f2ff0466f895d87\",\"/knowledge-medium/src/vendor/react-dom.js\":\"0ce202c94d285e86\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"88c68a119472de38\",\"/knowledge-medium/src/vendor/react.js\":\"c0352e5ee26f1e72\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
