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
		buildId: "a307b6c47a95-665d2b3f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"dfd61f863df3da12\",\"/knowledge-medium/index.html\":\"dfd61f863df3da12\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DV68zRfN.js\":\"1be8f7c42c874cb5\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"5c228ea6065c80ee\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BtiepXRI.js\":\"67991ac439aba8aa\",\"/knowledge-medium/chunks/FacadeVFS-CLGMXpG4.js\":\"eb3ddad133998f2d\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Dpjm6cKk.js\":\"dc3a6c577c48c709\",\"/knowledge-medium/chunks/MemoryVFS-NxWLWPHj.js\":\"4437b1ae79cac1ff\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-iIhD1miy.js\":\"84a9266ae797dc83\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-QHFD4idO.js\":\"c6aed31ce36f2a82\",\"/knowledge-medium/chunks/Preview-BxSvsTDp.js\":\"17518a1aee9ce521\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CEGW2lzF.js\":\"1a467c307699e45f\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CTSNVaaI.js\":\"2b7569287fda9a56\",\"/knowledge-medium/chunks/freezeExtensionImports-DkpnFE8X.js\":\"fb58b3d82821e811\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B8tGF06y.js\":\"69b6890228f17d6c\",\"/knowledge-medium/chunks/react-BIQQDvVH.js\":\"917211b9bd088bb8\",\"/knowledge-medium/chunks/react-BictlTMc.js\":\"ad90ca1d2c6a623c\",\"/knowledge-medium/chunks/react-C7UJv1Tb.js\":\"fc0b8e007c2637ba\",\"/knowledge-medium/chunks/react-CSa-YZFy.js\":\"40015df93dd9e627\",\"/knowledge-medium/chunks/react-CX8V4eW6.js\":\"31c5f429c44daaf4\",\"/knowledge-medium/chunks/react-D-Gcy8JY.js\":\"f46387ea1fcf8258\",\"/knowledge-medium/chunks/react-O6V4xgBG.js\":\"ccb5553e1af035dc\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DUxaMtDM.js\":\"46b4cffeae95719b\",\"/knowledge-medium/chunks/react-dom-server.browser.production--PhbnTQR.js\":\"8fb9d62b07e01453\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CC3QP2K7.js\":\"fc197bcb48b408bc\",\"/knowledge-medium/chunks/server.browser-DatE74xG.js\":\"29b17be78db9b3cf\",\"/knowledge-medium/chunks/textarea-BT_i05HV.js\":\"51c3518d6ead4766\",\"/knowledge-medium/chunks/ui-BSgju-d7.js\":\"b4675c0d49de6b20\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"c2a1e816ee56f041\",\"/knowledge-medium/src/appUpdate.js\":\"84b90e805cd457c2\",\"/knowledge-medium/src/appVersion.js\":\"a27be428bfd1cec3\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"59883a16f5a16c10\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"43a316bc98bb7e20\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"94ebc1c850ea76c8\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"1443735ed3d9b8b1\",\"/knowledge-medium/src/components/BlockComponent.js\":\"b63e23ce7edf130a\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"0a236b5eeb190149\",\"/knowledge-medium/src/components/BlockEditor.js\":\"174fac678aa49a0f\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"d56a7454b44d2277\",\"/knowledge-medium/src/components/BlockProperties.js\":\"f24fa3cdaa0f392b\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"65f9cc59f7b36863\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"36343bcddac3dc28\",\"/knowledge-medium/src/components/DividerHandle.js\":\"992902e16269f7d4\",\"/knowledge-medium/src/components/DraftEditor.js\":\"3c025d37605b5799\",\"/knowledge-medium/src/components/GutterPill.js\":\"05dfbcf570e71a8c\",\"/knowledge-medium/src/components/Header.js\":\"e78b1e64b96036f3\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"429111ca2df8767f\",\"/knowledge-medium/src/components/Login.js\":\"cf716867080998f2\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"9dfd6cd1ae3d9cae\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"a035532ea99a693d\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"18e60ba9c8d99cda\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fd80d7f4a5475431\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"a5748e501ba16f88\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"155c08092a933c04\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"8d5e53365ef1797c\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"d15095f276de4ee6\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"f6e8e4f0c90a32a7\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"1c72974fda7386a5\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"d6c4e50af2e9adb1\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"dc7ae9d588f81d23\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"f699c815887a603a\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"17405ed328f616b5\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"d72e49414c8265dc\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"d0e51a02995d9b4c\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"f4d08079ab4e3467\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"97c43208241f042d\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"6df3535da5b48eab\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"82710ca3ab9eba6d\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"e7854c7a16a08dd9\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"787f18dc63263e9b\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"fb52e33b666bb765\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"cad452a548881336\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"79539b6ac77f8341\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"6eef2dc3fb4fc2f4\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"6ebcd657cb2ee58c\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"8da67529b4c618c6\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"e99bb1e0fe510244\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"cb3a5eb8d0cde1bb\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"2c030a5c52bc1fca\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"13153f91b4120e6c\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"7f15538c2fa4df87\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"301f0404b8b9ebe1\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"899c6613dae24083\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"c852438fab4d4b96\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"697711431a212e1e\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"c2d243dfb02f7eb7\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"98ea39738e041846\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"dfbd3f7f9251a8a9\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"9c3b7f5b9192df52\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"11139c1dd334b4e5\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"7539d4e1e2dfbaaa\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"af8ec7629fa6b011\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"bfbe110095212053\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"440eb93edfe36b45\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"1bbfc6a140dceaad\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"d82c85d7773dabe1\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"c73140e2cae5c45b\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6f98e306e3da0431\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"589eb4c5d680c51c\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"44b69e87a30b65ec\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"cd07f679aa4d8e6f\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"9580df1bc9c512a3\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"394fbbb09c663801\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"f89c410184e60568\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"0f8a52e170d040dd\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"2387d3de0c527673\",\"/knowledge-medium/src/components/ui/button.js\":\"1338e150ce128db2\",\"/knowledge-medium/src/components/ui/card.js\":\"1b6cff77bbe68a20\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"205a1173396f646e\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"1b24b31f024ff362\",\"/knowledge-medium/src/components/ui/command.js\":\"c0970a1a81c21683\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"484e33d601ce0c3a\",\"/knowledge-medium/src/components/ui/dialog.js\":\"20bb0f0bd7c7e168\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"454637188dcf7405\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"01a31641855302ef\",\"/knowledge-medium/src/components/ui/index.js\":\"d165e7d11724d08f\",\"/knowledge-medium/src/components/ui/input.js\":\"1e143b4b95acb681\",\"/knowledge-medium/src/components/ui/kbd.js\":\"eaec6d30634444c5\",\"/knowledge-medium/src/components/ui/label.js\":\"d38c657b615035b6\",\"/knowledge-medium/src/components/ui/textarea.js\":\"d12d5935e797a108\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"d670c59a1ab9c47a\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"552602cd29f46f56\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"4ca0e7a026383e15\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"ded23716b71b40d4\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"cb1a0f742fa96526\",\"/knowledge-medium/src/components/util/error.js\":\"4fd0ef1f7f36c51c\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"51d4e406054ab14e\",\"/knowledge-medium/src/components/util/suspense.js\":\"2034c6f4eca24c30\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"f437323765b777dd\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"67b464c480e4ab5b\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"30608ab430d42b92\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"5f7e78c6d8573d14\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"40a97f40c3097f69\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"cd37c6b0a000f18e\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"77375c2170f6ca96\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"bcaab1b1c46286c2\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"a7e97c6fb5ab7bde\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"a7482ba7067fd9dd\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"33993605682420d4\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"7619cc907d7ff788\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0f57d8067c46f5ea\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"9d42a845f3d2f14c\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"cf21d7e97b79137a\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"7b7957150559592b\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"68a3f73b1f2a3b77\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"edeb08b379c001fd\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"b92482baefc8a61b\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"fa4748e702028f4e\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"2c2045bd3bf457fc\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"7b435094971ed6f5\",\"/knowledge-medium/src/context/block.js\":\"780aac0002bf22c7\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"45e3c5600fc7f031\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"4411e2ec17c1169a\",\"/knowledge-medium/src/context/repo.js\":\"e4d583d2d8e2e689\",\"/knowledge-medium/src/data/aliasClaim.js\":\"226a52e8baed0595\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"e32b9270483c7903\",\"/knowledge-medium/src/data/api/blockData.js\":\"d0d7902a55f3dad4\",\"/knowledge-medium/src/data/api/blockType.js\":\"c40033dd6313d549\",\"/knowledge-medium/src/data/api/changeScope.js\":\"071c430d37c926d0\",\"/knowledge-medium/src/data/api/codecs.js\":\"30377f3d583f2e9f\",\"/knowledge-medium/src/data/api/derivedData.js\":\"ccd5c75eb5d627f0\",\"/knowledge-medium/src/data/api/errors.js\":\"b46af3e4bba04a47\",\"/knowledge-medium/src/data/api/events.js\":\"5884aa160603e8c1\",\"/knowledge-medium/src/data/api/handle.js\":\"7b79a53a74f72eff\",\"/knowledge-medium/src/data/api/index.js\":\"7e5f77efbb971b5d\",\"/knowledge-medium/src/data/api/mutator.js\":\"7964d78ad81381c1\",\"/knowledge-medium/src/data/api/processor.js\":\"a3572b52dc40e4e1\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"d53e64527d51d220\",\"/knowledge-medium/src/data/api/query.js\":\"63133fdec14ddd92\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"53d5fd412a3d7aa1\",\"/knowledge-medium/src/data/api/schema.js\":\"7b79a53a74f72eff\",\"/knowledge-medium/src/data/api/tx.js\":\"7b79a53a74f72eff\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"9bd813eb76e68143\",\"/knowledge-medium/src/data/api/user.js\":\"b61be2bfb4c1432a\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"155d2b626334c89e\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"6ceacea4c44c1498\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"5a11622615c4fa7f\",\"/knowledge-medium/src/data/block.js\":\"21fbbc7eb400ca3e\",\"/knowledge-medium/src/data/blockCache.js\":\"41ac40a5fc43139f\",\"/knowledge-medium/src/data/blockId.js\":\"2ab0d0ea9261a51b\",\"/knowledge-medium/src/data/blockLiveness.js\":\"0c5372f16b9dedb6\",\"/knowledge-medium/src/data/blockMerge.js\":\"c11b35ccaf65a96f\",\"/knowledge-medium/src/data/blockSchema.js\":\"f1abaa01b27f7869\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"2b5e1125ef421327\",\"/knowledge-medium/src/data/blockTypes.js\":\"722bc17e58fedd9e\",\"/knowledge-medium/src/data/childrenView.js\":\"9df9ad63019f0623\",\"/knowledge-medium/src/data/clientContext.js\":\"ae8f7eac77ff2087\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"5bf607fec931b8af\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"950612005574aa27\",\"/knowledge-medium/src/data/derivedIds.js\":\"65099aa197bbb95e\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"75a9de6786859725\",\"/knowledge-medium/src/data/facetBridge.js\":\"92e1d6edc4d6bb57\",\"/knowledge-medium/src/data/facets.js\":\"d25b0f889afc9233\",\"/knowledge-medium/src/data/globalState.js\":\"b2d48dc4dafc2a66\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"5000c6c25fac986c\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"0bb28dbb3e064d96\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"6b0d3cc4b0298573\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"a8e37726caf97953\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"94d1e9e6107657c2\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"1fd0fe8a62580610\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"65c4b872abb85844\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"58948e35a38a94fe\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"2c463532658e705b\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"f03a372b527e6565\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"d312c8736c29d332\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"4eb1410e5beb54bd\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"9b716a216604b184\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"7b586abb4450ba69\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"a6d24e1b1c1b11db\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"7315606d67b054c5\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"4e0ce6336e856276\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"c2d33bc5ec097e7f\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"fc1fa0267d50d79a\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"c49a2da83e262fe9\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"d4909de1ed9bbacc\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"c37e464ac365205f\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"61e9b138cf47900a\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"d2cfe7002a1697a7\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ec62bb8c86c811cc\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"b5416167653cdb98\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"db321f36c8dfe0a4\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"8c3aa5bf5440c1c2\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"35d04ab7a24f3da2\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"9d087f407bddba34\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"2117b6ddf86fc030\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"c14c52fbab180a55\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"e34eaa1ac092e374\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"319aec222f6841cf\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"46b8e3b5ac9388d9\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"81bfaac20b03d4d3\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8bde506907eea405\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"c010254e368beced\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e15f7da672d080cc\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"d243ab05aaa875c1\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"63b62c221e46a6c8\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"f8a6919c320bf985\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"72bcaea2ddf21b71\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d8efc695ae8edc64\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"3d69fb22611f073f\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"ca97c8cd0987b776\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"0f92a6f02c0f43ff\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"e5e31ab7b85d7244\",\"/knowledge-medium/src/data/invalidation.js\":\"f50d7ff3e6d274a6\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"695c0c84c1c1e7dd\",\"/knowledge-medium/src/data/kernelPage.js\":\"cd83fa317a4f242c\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"5866c6bda4e8f01f\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"78a4c938ab958617\",\"/knowledge-medium/src/data/localDbStorage.js\":\"0829cb5ab4a4b49b\",\"/knowledge-medium/src/data/localDbVfs.js\":\"f9e280b5dda7a80d\",\"/knowledge-medium/src/data/localSchema.js\":\"ee9d80224474df60\",\"/knowledge-medium/src/data/maintenance.js\":\"32ad21e924190c44\",\"/knowledge-medium/src/data/mergeProperties.js\":\"12f9514ebbbae475\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"b93047f517ca3087\",\"/knowledge-medium/src/data/migrationsPage.js\":\"4863eee1096379b4\",\"/knowledge-medium/src/data/mutators.js\":\"f8accf7887780c1b\",\"/knowledge-medium/src/data/orderKey.js\":\"5415c3780ee36f47\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"86746d9290c52707\",\"/knowledge-medium/src/data/outlineSurface.js\":\"372e341e495c002b\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"fc4d384bc31e49ed\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"f26f5d51a8baf672\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"26cfd03e1f2d9b5b\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"3f51799efb890d74\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"dfc7ce1cab606dcd\",\"/knowledge-medium/src/data/properties.js\":\"9f41a4fcbdc1f082\",\"/knowledge-medium/src/data/propertiesPage.js\":\"5d6b734f1b61f8c6\",\"/knowledge-medium/src/data/propertyChildren.js\":\"19c7f3007cce9cd3\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"d074dd66c2e1dde6\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"ab4bdca733362290\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"8cd2e7c43cea6a59\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"0fd761bf4b2aa91d\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"e8dbef420634ef16\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"d9d1ab3d29de8b70\",\"/knowledge-medium/src/data/propertySeeds.js\":\"1076c2d106dbf973\",\"/knowledge-medium/src/data/recentsPage.js\":\"66dde687631c8190\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"701052e59d67690f\",\"/knowledge-medium/src/data/referenceBlock.js\":\"0c6c428b25eda50f\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"007b563cda527b89\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"7ceb4fa1f927ec1b\",\"/knowledge-medium/src/data/repo.js\":\"17c5ea865d445457\",\"/knowledge-medium/src/data/repoProvider.js\":\"72fa20f8834f4968\",\"/knowledge-medium/src/data/rowProperty.js\":\"981a3958c3fea4ad\",\"/knowledge-medium/src/data/searchFilter.js\":\"cb40f03ce367fd0f\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"79e7baa1c42a2783\",\"/knowledge-medium/src/data/stateBlocks.js\":\"490951f675d00871\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"dd29a500a7c9636b\",\"/knowledge-medium/src/data/structuralInsert.js\":\"7a4e15703288254a\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"a47ac8f12b862182\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"dbeff198c30f7bca\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"a2076fc479c987c5\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"994264ea7fd4d56b\",\"/knowledge-medium/src/data/targets.js\":\"0cd29ae5c3923c57\",\"/knowledge-medium/src/data/typeColors.js\":\"e49c001b5441faa4\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"25f9e0bea63b4c71\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"4e59aeb69ae48f12\",\"/knowledge-medium/src/data/typeExtraction.js\":\"4e20e7ff827246bc\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"79a9e3758ded8f60\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"6b097f10e0dcb1ce\",\"/knowledge-medium/src/data/typeSeeds.js\":\"0e26d706706a89c3\",\"/knowledge-medium/src/data/typeTagger.js\":\"2d668fc861c0a3c6\",\"/knowledge-medium/src/data/typedRecords.js\":\"d851bc8f14486e8d\",\"/knowledge-medium/src/data/typesPage.js\":\"ea0203930ed414b9\",\"/knowledge-medium/src/data/userPrefs.js\":\"94aa227710c79c2b\",\"/knowledge-medium/src/data/userSchemasService.js\":\"12c23819a8fd2341\",\"/knowledge-medium/src/data/userTypesService.js\":\"c54e30d917a13311\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"661f81c5165470ce\",\"/knowledge-medium/src/data/visibleChildren.js\":\"7196bf82dffc4ba7\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"760352f5fc7c99fd\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"1f2399e37a91a394\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"428fbd17d5385f06\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"680ba55ce428c62d\",\"/knowledge-medium/src/data/workspaces.js\":\"14ed0bb7bf8f8004\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"5c734181326a383e\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"0e2bb3dcd977c22b\",\"/knowledge-medium/src/editor/atTrigger.js\":\"a75c36855ab0f634\",\"/knowledge-medium/src/editor/autocomplete.js\":\"6c02f293cb54fa6d\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"3ba9c818d1f57d5a\",\"/knowledge-medium/src/editor/contentFlush.js\":\"40fac17b3601e45d\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"6a9a1a32830347b6\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a6f0f375007f5690\",\"/knowledge-medium/src/editor/insertImage.js\":\"c88c12392f11e130\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"8e33b6fa9b36834d\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"a076a04b5655a4dd\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"69daeb0588343f6b\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"479c5889007e9eb2\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"39b6eb73765c5614\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"faf8035214d55e21\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"89d506a3d489f028\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"33485a154cd31c9e\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"a42e1f5e1dcfde14\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"833e8c33bb6b3a8e\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"6cb05cabeaf5fd6d\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"286c442cd1b02f66\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"1c542c1ac1f271e0\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"c671a117169efe1d\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"bab99051dbe7e271\",\"/knowledge-medium/src/extensions/buildApprovalRecord.js\":\"fa7792db69993056\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"a1cf95ae811f66f2\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"8ecf3eca75269414\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"55f5eaae5f4b9079\",\"/knowledge-medium/src/extensions/core.js\":\"7485e372c734750a\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"58de99ae3e21772d\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"cd6945a4818c9121\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"ca7e9a03af10ca53\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"c693ff9eca15ff03\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"d6e37282f0a7cf5f\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"b0819e2d845ee6cc\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"7a3ffb33df2c9b25\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"5b4b08535e32960b\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"2a76253d35999d46\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"08cc8d0add3a52f2\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"1ba2480e27487bec\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"6329675e76e8ad95\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"07ca2e7d6fb01766\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"7c0d1b3a10222408\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"e8f0954fe4dde46a\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"117118ea6b2abe32\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"d3c19db445291f88\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"735fb5857c1a9ef8\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"f4da5ef13f4778ca\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"4db1d2bc4508b8fc\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"7b75232f27b81a45\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"2da0a77fb5d75d6a\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"da93a67f2816ee32\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"04a86f410d622e17\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"7cd9ed605c1ae215\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"dc68b9e92f454c0f\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"0a573e855312ed48\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"ca41cef6b078638a\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"252859d102e4e76b\",\"/knowledge-medium/src/facets/facet.js\":\"2a07c1bdc14d8b76\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"99c0de2b43454de4\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"1d7ca9ba2d3aec5f\",\"/knowledge-medium/src/facets/togglable.js\":\"bf45d7658b4e3878\",\"/knowledge-medium/src/facets/variantFacet.js\":\"2c063943ca4c9dfe\",\"/knowledge-medium/src/facets/verbFacet.js\":\"ec0291d8e539e634\",\"/knowledge-medium/src/hooks/block.js\":\"31d2ed947523f2a7\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"366a0104bc8a1168\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"4ce27ca50d394c4a\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"d8e34d153a9cca4b\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"36dd9d14a0d7ef7d\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"c8663b63b4759ba0\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"a13119033e3d73f5\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"1faca962a5ded6fe\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"1b63bfb21e43d0aa\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"adb2daae9eef2124\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"6ef6865b6664242d\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"c9db0e85ccac5bfc\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"c7ed900375d2f204\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"6d27ecb8be3420c6\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"f37a03128e6c3424\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e1b5d375ddac9f9e\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"ed99743f687aba0a\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"3b5043977cc24a63\",\"/knowledge-medium/src/lib/utils.js\":\"9873136000f1e82c\",\"/knowledge-medium/src/main.js\":\"6ff18f7e3ba08dec\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"0203148f152ff070\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"861224c207af3b3f\",\"/knowledge-medium/src/markdown/context.js\":\"10e81ff8f0093012\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"e1fb85a24835d64a\",\"/knowledge-medium/src/markdown/extensions.js\":\"83f4c89091e25e4d\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"515fdd4f37f540d3\",\"/knowledge-medium/src/minimal-editor.js\":\"2f9f64632537299f\",\"/knowledge-medium/src/paste/armedCut.js\":\"5d1777b93336fbff\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"ef0cc74a472fc06a\",\"/knowledge-medium/src/paste/clipboard.js\":\"a32216cbe1c1f8f7\",\"/knowledge-medium/src/paste/decision.js\":\"37afe391433c72af\",\"/knowledge-medium/src/paste/operations.js\":\"4ad1e28c9c547802\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"35a4ccbb3ab11cd2\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"5d145a659932ffe9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"dfba020a2695a558\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"c9599a7a2da4b5e2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"21ac4e641b116198\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"79cf682c81e474ef\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"23ec1e81e136b572\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7195d2652a119317\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"19e52383dfc3b1ef\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5a8d580998a15272\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/retryAgent.js\":\"b0b90142ea9228d2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"33be090d2936bfc4\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"19de06f98465f29c\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"799427e6b301d979\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"da6a2336cbf73446\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"bd5ca96b26d30239\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"3dad5f53593ed845\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"a00af1e2d07f5111\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"4f073f6c40dcb60d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"77594cdff83be96c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"1829bd8f056d0b2a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"ef9d8578757a8536\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"72edc350daf67e94\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ad41079c5593f2a4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"120e155604b460bb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"f5377fe5f0497cb3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"96344aa3992bd1c2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"bc9b128c178828f8\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"884e18d46c79e245\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"92412725f0cf0108\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"57166c5913366cf7\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"69c7df4eb294aa5e\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"fcfacbebe86e016c\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"d438af32b43a6ac4\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"17883b26216900c2\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"0c046e4dc1f0c768\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"c8496695c1c6e588\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"f79a3b9a883e14f2\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"76c68d0960679ca0\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"b0444fa41d1e75b2\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"41ea9ac16ec0811c\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"9787ee114ac749fe\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"682d33cd53b2552e\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"fa172aa9dda3149b\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f0b8d2f8323c50fe\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c458903deea7d1df\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"b7d049401d247929\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"98754065ed17290b\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"8e7940e9d25bfefe\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"095fae5916c33263\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"db90b230b947eab8\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"32ff589b350623da\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"628ce55518a50214\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"8b053537cf385d08\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"a926998dba2346b8\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"0aecb27b2322def3\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"8e6cde7d6ceda585\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"d2f6dd7bf9efc11e\",\"/knowledge-medium/src/plugins/alias/index.js\":\"b5b1c97d0c6b1b9c\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"f401316a0e664cfc\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"2d086be5dd5a06de\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"b7d66211992f088e\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"2d69de61c72008d2\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3c2d70c49d70728b\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"56a21a8d20381f98\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"c980c4323393635e\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"77b747814259f041\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"b94a6a04d3272010\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"2afb6b6f4de63206\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"ed83c828bd36b3c8\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"3c51f5d2070f6581\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"84489f8323cc2ec0\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"0e8f8aab3da80e5b\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"669179c6aca7b2a4\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"47304bd518a89678\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"ebfed3626731e742\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"9bae50e6c917345f\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"ec703065fc9d65d0\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"aa0e4d945809a1f0\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"000a0d980b208ef4\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"cec503ccb3c4ec08\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"43241187c53b10b7\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"4db85f0af4cfb078\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"4667035201b249af\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"709ebafd04e238cf\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"131a5b55e8f25c45\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"7cd1358e7a0d2852\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"c124d4623abe61cb\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"0088baecf920a9e1\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"72d72f49d1560b94\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"6ffe95af21bd9f6a\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"b42a502b32913c93\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"be3e21598e799c59\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"a5caf4e7046c8d67\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"66a795aa63ddacf1\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"f2f0271e95b2bc3b\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"153b9ed71f96c2ca\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2911ab73d75e8fd9\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"a32658e6c38e4bd4\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"195e6c50dec0de4a\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"2130a3947c94c54a\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"a59a2a643e376fd4\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"4952eee2bae0e2c3\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"6061e16f6a7db198\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"272cf506042945c7\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"4a207cd3eb198152\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"c475cb24c995d7fd\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5c2f6a5eb3db11f5\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"128b3e98d4327bef\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4170acf8c5ee5f78\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"efcfb4f4d2190bdd\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"3df005fe3f003eaa\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"5a95984f25c6becc\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"0bcd458384d779b0\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"df16bf09b51ddce8\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4907607ba0a26f66\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"972b57c4f1f8ee32\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"877b4c9c7d65405c\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"a74631433f86876e\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"eef91e56c065772e\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"67a9ed21ae04d2d8\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"7ed86fca3ea9e93c\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"c3201f3a5a274e70\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"6a42e0edbc98f96b\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"e89f5236cf23f22a\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"7a0ccfa0be156bd9\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"addf5385232af526\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"a03c4c3a079e9d61\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"65dddbbfba12c03a\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"5d8deef5af730c77\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"83db9015670522f8\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"8cadc0e97ddb9626\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"b0d81079e2c18f44\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"e61f3feee7be94f7\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"a5ef7cfa5b0c913f\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"cad348f9d2a8c930\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"8de06486b28cb9ae\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"9303360be4ae7524\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"4563dd50e74ccde5\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"8a1903994d2fd0cf\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"378eba5461278ed1\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"8213573a688046c0\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"99adcfb9ac7c3c9a\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c81cf2017ab414e7\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"6aa8e5bfd67272cc\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"1af5bf28db3c72ca\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"d1a7fcc4fd215106\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"3e5932f5b985b651\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"eaededabd42804ca\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"ab46d1d264273821\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"5acb28a7d6c0c6b6\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9a6b1b730340c596\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"9c6af7cd5f58dbef\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"6b57ec3fbde86664\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"41907ef09dc0ecab\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"bcfde47a69952860\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"dbe3513a8fbe7241\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"11e4c6eb174e0b79\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"236928c23dea9bed\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"1ccbdc5c4f097fa9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1ad0e5d63bfed73d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"9162a8122be9217f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bb0feb90c626e866\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"619022a49278d33c\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"f09e1f2fbd643d9c\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"9800f4aaa268e3f5\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"530fca80d2efdfbf\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"b8d4a28e9d63880e\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"0d2e49d899eee970\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"71e4a5cdcadcc0c0\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"ef88e1ece5981cce\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7f839f71ae3cfbf5\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"ac4aff4084e2fb21\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"a07cea1581641239\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"a955453f62fd64fb\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"1fa65355d9e02484\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"4ad2581b74300f36\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"1f710495a217cb65\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"e453506b2a8dfad2\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"11d75d603749499a\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"c66226ba23399737\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"77be65527fe777ac\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"c962eef86fff6e76\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"40d73820092916db\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"1e1577ebd82a62e5\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3aa140af43246cba\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"5c7e0c3b31e75b56\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"45425d4a65d334db\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"8c29ea2b4926fcb3\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"0112f6d2f54e6edd\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"5b30b4101348a765\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"a9e58a80117529d8\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"b3ea060a1e37974a\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b897300c70261a5e\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d362edddafec8bcf\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6f6448c59056bd80\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"07629008fabcfb33\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fe5fb168b6d34e1d\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"f999c6419d2f4403\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"95cb9a82a1d00f5f\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"9ccf5755ffa42af8\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e638a84d379c37fe\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"d1451dd8e87cd68a\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"03bc1745888bfea7\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"083a10aba6c6c2a5\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"a2e48de4f3374d77\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"1cf80e9a0db07b95\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"bf992bce27c33b44\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"be197992637ba1c3\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"55ea7dac6a4698fd\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"c9392552ffa2f150\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f0d3dd1acd7d9e26\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"08365b4c6cf52b71\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"49428ba84f0cac2b\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"a6722abea1c0f353\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"5e67d75ef805144b\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"a156239bcff8cd3e\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a45d4098e1c3f7df\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"1b8b14b4f508bab3\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"8bf8bf41058b43d7\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"cc4e973f736cf461\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"4819bcceefd4c429\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"3f6606885d928181\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"3c1ad4d1020f4c2e\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"5788692ff0ca7342\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"8c38317d1fcf45e1\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"12597949e904589a\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"214e8d52e3c36d37\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"a305931a387561c4\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"be50fa77d3c42a55\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"252138ca85b305a5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2512053c417534e2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"902d9ae7140a0ef0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"7f371c1851c6bf2d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"bcc0a769eb2948e5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1f82e5ecc3e511f5\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"aed29e47dc943c91\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"c04824861db6b09a\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3f441cc950229256\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"d652cf728b17401b\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"480bb8c1f2ba2338\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"013c11732d690ece\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"1bde4e95a678426c\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"fe9a2fc5c01caa85\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"a9fb850468006251\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"39bc5cddc4b0b428\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"cca134615f1da367\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"cf6644cf573619c8\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"6a438f74f603e5b0\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"1db01937ec900b4d\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"d7fed4a363e45b94\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"a3b3701967def147\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"99cca4f99690e2ec\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1f0adeb058f7eae0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1e767740ef0f863d\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"cae3ef061fdb0c10\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"3a92058d05faadd1\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"b997267f2f212dfa\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"d73de27999b8abb6\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"58abcf22eeb4d835\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"61b53dac4c1e27be\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"43618cbdfc3e9523\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"e1aa0d24567a5e65\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"e5f0139f635c4fef\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"11a12ffe3f84c774\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"b1be5dd5789c2601\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"f3fa2770ca5c41a5\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"6ce1c068c6d33664\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4ec1a6abc079d06b\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"0f490e6c244ab428\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"53c3a521ed2d19b2\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"9a1faf981cf58919\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"b6bbb3ff5135af3c\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"fc4e7503e3709923\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"394f17049daf43b7\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"bdcc1c19a740cc85\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"44d7817c5630b1a1\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"51478049c3a22989\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"fd5bec5f726f0553\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"064206773ca5347a\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"42147b70b017cc38\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"a514eb46cc0ac058\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"6944dfb9c154a869\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"8b52b9d3fb6ef8fc\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0a47f87798cdede1\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"b55e16589314f012\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"74cd87ae72a077ac\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"2d051db33fd8eaa4\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"367b1673c8871c7d\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"939da6873edd87ed\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"d8e376409353e705\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"6c9693d17913a697\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"059550cca6db650b\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"e9cc44b9414fcd2a\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"15514447a613aee2\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"b76b577dd1f12410\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"c80dea6af8a42f81\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"783eb2535be01019\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"ec189121b8613b3d\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"9759b3193c9cf37d\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"c730562294a70175\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"9478f10ded960433\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"7ddf0aa1781cfc07\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"85ef9aec9b0e94a8\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"fe05abcbf691e9f2\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"68a26c6e9173503f\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"c9596a41f5783e71\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"bd789a229418188e\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"c79dbeefd21bd4bd\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"1fb2e8d7dbfc252d\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"f0e50b130c5b7ada\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1e400a5ee62e2678\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"e27f761b873ad654\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"4a2bc8f71f7c7e17\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"de18eae2a5f7fcda\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"e8460b734c222e2f\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"d27b77b2a2d3c28f\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"689f3f2cabe94241\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"1890056e74b50baf\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"409532e627deb5c6\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"ef0a5c1514052599\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"fe378e5c327b5010\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"11a5c48d927a443a\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"d8b6088d08033c8b\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"102d0b0dc375d930\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"de9954270aacb825\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"d480ec8cf83405f7\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"659aafe4ebb10df6\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"78afd418bd763a93\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"1780886f365691f8\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"d077f401e6da4a97\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"8008a541514dc34b\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"474abba98e44af3f\",\"/knowledge-medium/src/plugins/geo/index.js\":\"77c34df458e39380\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"22af62ea99fe95ff\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"c37eba90d38cd54b\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"66e1b496f973d970\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"cf3bab79b259e2ee\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"2dd151f43954b446\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"5d909bc101f11b35\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"4c3c390363834ee8\",\"/knowledge-medium/src/plugins/geo/query.js\":\"e261213bca97091e\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"be324611c76fd7da\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d7452ed0301d1b13\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8411b1b6f2d5938a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7fd28987caf323a0\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"1b3ab723ada7315f\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"36d0e15af62c30ae\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"89182703c430e23b\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"222c55076c39aca8\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"44989a5e81f9fcb0\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4f7f59af2791e82d\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"abc02add929f2acd\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"932427ba95ab1e97\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0cb21c43ecd3e0d9\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f10006a6a766b4a6\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"0c235986917565ee\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"c4b995fe1c882411\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"c55142ed3f934165\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"1b4570f491818e5e\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"a7c999ecccc10582\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"7647e7d01eec1088\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"af22cfe8ad5b8776\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"20db94f2f5fc8b91\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"5598076d02aa8069\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"cdc78c6de000bdce\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"2ccfe517996a4f7d\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"24d248d90ee012bc\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"1adacd2cc5e8cedc\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"f0169d570a5f2d90\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"41e9396ae122add2\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"1b670351a416aa05\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"068e3bfa5394c8b4\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"06b72987a00883d5\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"31a531e93721b7bf\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2ae8415e11030804\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"23b7cb2973aca968\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"3bca338bc2ad2529\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"1ee8203812659bdd\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"952d84707b422f5c\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"4adcae8d5d3bc6f2\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"3c4615571968af28\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"589f76a60b9cf2bb\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"247727b94ab41146\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b59e74762b560e14\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"71f8df2cc33e15d8\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"824dbf4f2f9580f4\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"887f94ad7cc6984b\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"b700e830258666cc\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"4ab8965a3b543faf\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"461102a1b4b484fb\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"3aba52b1c0c7c085\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"c8276a5f3689dd00\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"827bcb7ad321a11d\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"50b4f77d00e1f276\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"c2d0928ffb6ceec2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"8a8dd91dfee8cfca\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"36eb608c746c1017\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"bcfe2ce4c494ad61\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"f7e30fd709207a8a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"440c4862323a0adb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"700d698835d57b93\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"80470c24fe174aae\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9091eb3e7452b4e9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e3b37cc6bd9a9a49\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"2fd82d6180067a41\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e512b5318894d781\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"29b39108268da15c\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"1d8fac211c684f1d\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"f4254402c9fcf96b\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"1c2ca39be14a68f5\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"db2d33563c953c46\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"187cd0f67634bbd3\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"6d40e98f37e7c92c\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"24a52e6fdb45ecb6\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"dd2eb4ea5b7b4e26\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"23f8fab45e1890d0\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8affded9b18ce327\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"39a92ee1bd638a71\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"381445e7181096e6\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"1dc166f90f69da7a\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"51a952b60258aa0a\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ded1718f6cfcdd4e\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"fd0708dc2b736394\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"95e6a439707bbe4e\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"46ff2880366dd245\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"8ce0996bd63d2435\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"3d6b11033db4c775\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"ec68e41498044870\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"3c1f5676dc5e40a9\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"d9abefd591fdd83b\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"13817182a4f414a5\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"fbd7fc5a255397a8\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"5cf3cf83824ea327\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"259512c3996f10b7\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"1e8c8b2e2d916e66\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1aa376ab6407d8e4\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"e4edd2ad6b10bc85\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"5e6e0fc5a72ebf81\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"e9c077fbdf5c4be5\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"1c8b52776daefe70\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"d1382e2cda6580ac\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"22efcb9d7d76838d\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"6815569d79dfbb4f\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"11bdc7342cc8e700\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"ca8797b0082b0682\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"f14305057357bc9f\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"8091ab0f9a93f68a\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"72156953660d2aa7\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"93cd21b1a2d3aaa6\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"689c2ac09a9ea780\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"ac3e2663563ef266\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"64e3319aa9e288c5\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"0fd5f3144f397d13\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"43c8def82ce0e751\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"755f9aa6f9faee62\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"bcaa864a8b7f16eb\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"51765e477be305eb\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"d5bc4457310a472e\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"7229bee35daa90e0\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"fca9fa8efcc25e49\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"ff1b82f946679e0e\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7b3a5a9a38543994\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"a8c58df56d73f2a4\",\"/knowledge-medium/src/plugins/recents/index.js\":\"712e441dac799c07\",\"/knowledge-medium/src/plugins/recents/target.js\":\"0226f2942960e533\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"e4a94be02dc586c4\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"861e0efa0ddaa6e2\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"b92e68e9ace507c4\",\"/knowledge-medium/src/plugins/references/index.js\":\"0cb1f0951aba34c3\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9b1e747bdca3f607\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"2923f54682bb5237\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"5908e687e548c5bc\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"68312f0b3a85e0a6\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"408e725b4d1e0b81\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"85b3a6e57f9a04b1\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"1109c7b701c7c9a1\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"24dd88b129a19376\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"54552d1743b01e23\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"baf6f05a42c405fa\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f3e39335a76e30e6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d06fd7dfa3461606\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"3457772f4bad3598\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"e453fbec55e4abdc\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"24a7f3fd3485b477\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"09e34123b4878c59\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"1df9ff806179cfcf\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"e123ca63a4874df9\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"19403331d5c25083\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"dfc2c75917414aa5\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"292477f78fe3c613\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e18c11b4a82d9074\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"54a3f08edb44b51f\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"e5626cbbfdbdcb04\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"83d2617e58baeee8\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"17cd903251e24398\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"a2848f440f6745fe\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"ac9dc6df8cf7cf85\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"2eb03e42e9458f7c\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"de7ac553b364aaf9\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"69437c7b9987dcc9\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"1ba15d0201d564ce\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"3dbdbfbd425adc03\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"a534b6db29afb092\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"09d654514704ff4f\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"e5359bcea2ee7e53\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"e0da1e26a318add0\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"1cc3fecf070904b4\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"4614b0a3a4509a56\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"ca680542cf820efe\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"0b82b9c63d9cc055\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"4bfe3b2ef2efb2e9\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"4c7ecb73079cd91e\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"8eff13829e210108\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"f83eacba46fd5322\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"ff9b3f4fdcfc574b\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9cb6310f2db99b39\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"52889ed834b71a6f\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"25867bb71ebfc3c8\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"871f6cea36a1ca82\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"46e53c48d7ae2c15\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"33d941ca34c602ba\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"cb54a16f83c068bd\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"25b90ef1a8675c80\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a387b42912b7756a\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"201066ec8f640f3f\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"53d9642d4042f2d7\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"b475fc40d142e3ba\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"473d158843d1e90d\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5abffda8dd744894\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"4830b8e25e704d96\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"ea0f71460ea31320\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"857ff5f926d56238\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"66c4a6fe6c26f394\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2fa8d0b2c5e8c100\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"cf2baf9e65a24fb5\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"a1046516b73709cf\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"27d26bab21f9e946\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"a239a3773c2aebfc\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5ba41f7433e75e3d\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"656c2d9c26154bbf\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"150891e324d488d8\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"59390a38335cd6c1\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"27474a20ae79d250\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"7ffe15eccd27740e\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"9743462f94e3a0d4\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"84e0b797049ae99a\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"63c59323ecce8770\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"29c01ca9db6876c4\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"21c62577b4971909\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"176a2c39b284e596\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"f3bf9442c0df541c\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"98ca7626e5131b5b\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"cad27dc3d6c79ce7\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"91548ca292761af2\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"73829ada1f9a31db\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"4858409b131880f5\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"476beb20a5f94f8c\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"67cefb4cfc234a7d\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"b0a4c4bd6d4c8daa\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"e6f3f77cd04dd918\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"0755bedd74cedb76\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"c9576481e5dae744\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"34dd597a66b03c3e\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"af35ef7aa46136ef\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"62c8725e720d7a01\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d72d471ec05fb28e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"7528328152e42002\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"1da571cf759fc617\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"a146d7368d875ec4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"9384a57a4b541d66\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"d7c8a66664d8c902\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e2ad12bee46c9d54\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"81178c93cd45855b\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"d7d3c9e894e33740\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"12c7073e231fd618\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"70f61f321b5b5658\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"51f42414b3766a57\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"7bce012f1c7da6e9\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"848c6fabdf119711\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"58441d4fe69228e2\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"025576cfffbdd379\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"f2269d001789ff3f\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"de28734f8aa50b03\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"097785d07ae5696c\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"1dff306812ebfe84\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"521b2da7261cafaa\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"6342b3c952f72dfd\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"60680dc8555a4a39\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"1f5b7e359899f40b\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"0d42e8c6cfcabfe8\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"a7d360e6a545c856\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"3584605f218885eb\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"e2774d15f6222301\",\"/knowledge-medium/src/plugins/tables/index.js\":\"cb38ecb6bd06bc97\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"f7c2549e5f69a1cb\",\"/knowledge-medium/src/plugins/tables/model.js\":\"90fc41e5313b9be1\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"de04eb262fe4c1f1\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"b9b2bd596f16b70f\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"5cbf8b7499985ebb\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"47af17a544358169\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"f1190512adea4e1c\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"3fbfb9e6c899bf73\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"8a1268f8ca15e917\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"6a332aa3753c54fb\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"8acb7155762df22c\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"ab46adade70a99b5\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"817180c073d0929f\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"03a18f22376a6a19\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"f7725a7e28f5986f\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"1168f4c9a8ef6821\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"f9d385df17f234fa\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"261ebb1970a60354\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"33a94b6e4994fc87\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"38767247cd32d955\",\"/knowledge-medium/src/plugins/todo/index.js\":\"58ae31905ef1f75d\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"bff2fcc9bef1bd5d\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e8f0cf680ed13af8\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"de4aa40aa6eb484e\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"62ee23c68ecd6fcf\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"2c66ec29702c6cf9\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"a94a3bda451b54ea\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"aa378763740b558a\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"8218737ea6ea752c\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"e55267ef3faa0c73\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"7a0e844ac1dc7942\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"6b5a3a2b1bd875f5\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"c306fd67d61d0c06\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"9c667d63f4c70624\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"7165c0130fbf28c4\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"f2a7865b2dc65f17\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"cda95364f2762052\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"bd06e87a17fb5f3c\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"e9b0ad165e92c8db\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"30ef86e1b1d5e321\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"dac66e4990d17d0f\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"883d5e1897de9705\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"8981800cc883c71b\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"e758a380ff7c8a27\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"11a7588f2e68b542\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"3dcca4b3670bf6c6\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"557fc38413c689e5\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"58d07f90d2820a1b\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"3480c87678b3b32e\",\"/knowledge-medium/src/registerServiceWorker.js\":\"0950b681014f9455\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"45cf5cd7b6bd0fa5\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"0259de4ec93988ec\",\"/knowledge-medium/src/services/authStorage.js\":\"251122dc97baf567\",\"/knowledge-medium/src/services/powersync.js\":\"bd8c5966ccc477ce\",\"/knowledge-medium/src/services/supabase.js\":\"da0668f089291c40\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"6f606db721a10773\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"ecf5c1f30dc4e880\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"2513f137c05c498e\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"a2b7672601e5729e\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"6a07909222e0f3dc\",\"/knowledge-medium/src/shortcuts/actionKeyHints.js\":\"b55440035fdb04ed\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"0e8fd44c5dce9d7a\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"7d6bd04abbfef8f9\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"59bd5a75c8bf1142\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"b9f6aeb27ec7f4aa\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"179e016b3fa5ec61\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"8781576a11e5d826\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"87b7a47caff0c3b8\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"c2cbd53b0a2d32f1\",\"/knowledge-medium/src/shortcuts/formatChord.js\":\"19039f16fd4bce7a\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"1dcae2346a9d074f\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"728e3d89119d9d05\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"345acdcfdd5d48d5\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"3d26f3e34ac3b097\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"ab21a7fc6bc28deb\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"2635a0c056c64527\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"6d1b35392467a196\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"92f4f8c6e1000521\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"48e82569ef3d5f36\",\"/knowledge-medium/src/shortcuts/types.js\":\"0e488836df171b0d\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"42f7e78f48d5dd9f\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"9f776fe6b32e161e\",\"/knowledge-medium/src/shortcuts/utils.js\":\"ea616095bb5fa7a7\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"7d4a9aaf9bdb6d92\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"3459d3c8fdf970bc\",\"/knowledge-medium/src/sync/byteTransform.js\":\"d4c49ea9ed66dcf9\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"042cb5e03e4204ef\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"2749d544caa56cff\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"9f009ce67cb22ee0\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"3e60332ab8f9c86f\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"430fd9c13555fea9\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"d9041dcebdbd134d\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"d829a9a59d21b3b2\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"1c77f1e4a40fd6d5\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"0405a058be917cc6\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"5c410f32d957ccfc\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"421c39eb8f761117\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"e1180afd293cc573\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"7ce37ebc0d9a7462\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"5567efd9f4fc79dd\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"3995d39589b95b6c\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"528001f7a4385deb\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"5370ecb00a81ad5b\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"4d8a93706e0cf99d\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"30d6dc84f3ef5783\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"c21b548533c5cd73\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"ea4acd7cb53e07de\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"6989426951652129\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"05281b6a566d20e9\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"bacbfdca66104d64\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"af924a012e286b96\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"5b271efa64f366f1\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"d5e238163912044f\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"88db5e1fd0ca89aa\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"37625b79fb293fa9\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"8ceb3641471303bf\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"60cf1963e1033936\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"f41b0b225205562a\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"c64ae8465a67e148\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"5bb62c87b2fdc3c7\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"e9af0e06f089f856\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"5874a8c00e19d2d1\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d3a0e032c28a2e3f\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a2640cad2ced3dc3\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e4992a53b32f8d32\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"22982c055afac39b\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"8ef1d40b76ff67af\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"0e1c7b9404a8f83b\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"3d7fdf726481c7c3\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"609ac5c2249ea3ee\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"e6e8ee4e4bd99030\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"8cba17feff5a2770\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"903057f1f8e2c64a\",\"/knowledge-medium/src/sync/transform.js\":\"31c592ce557d3165\",\"/knowledge-medium/src/themeBootDefaults.js\":\"e8318123a4428c80\",\"/knowledge-medium/src/types.js\":\"6ebb020203d34a63\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"cb70d4f2dad12ed1\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"80adcd32fcdb507f\",\"/knowledge-medium/src/utils/array.js\":\"3cc2200f3edaf766\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"deadf831054f3bb7\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"b008d3b51f37d2c1\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"d2bb0a08553bbc94\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"c3b8695b8628707a\",\"/knowledge-medium/src/utils/callbackSet.js\":\"6cd7da88b7156264\",\"/knowledge-medium/src/utils/clientId.js\":\"ab01640828845b7f\",\"/knowledge-medium/src/utils/codemirror.js\":\"72fb29d45a445c33\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"376ec8c2a143d892\",\"/knowledge-medium/src/utils/copy.js\":\"d314ecd1c1264121\",\"/knowledge-medium/src/utils/dailyPage.js\":\"85f27273d2f15fb7\",\"/knowledge-medium/src/utils/dbForensics.js\":\"55eac5ce73e5d5ba\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"c0688155210de987\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"b9c270d9aa27e868\",\"/knowledge-medium/src/utils/dialogs.js\":\"1f40f94160d34ed9\",\"/knowledge-medium/src/utils/dom.js\":\"3cabfc0d14d01a18\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"64e85505ed4d0906\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"6dd221600ee7671e\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"7120e655e3856cf9\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"c71d870d3501e2d9\",\"/knowledge-medium/src/utils/flipSlide.js\":\"9388224e58dae685\",\"/knowledge-medium/src/utils/fnv1a.js\":\"da82bd1c72cd724b\",\"/knowledge-medium/src/utils/formatBytes.js\":\"fca102903b9a3a69\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"3f6143b454a3d876\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"1260bc107e947739\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"98d24dc7bea64ad1\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"6baec1898cc53939\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f5743d98b301ac65\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"6519af4dfaf500ed\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"84727874f44db590\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"423aff36a265f217\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"9f2487db6f26669d\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"67439fb0b826085b\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"9e8c55019d3ceb60\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"f082e3254fbae00b\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"d9bc30da84f432b4\",\"/knowledge-medium/src/utils/markdownParser.js\":\"3c6c8b88f606e2b2\",\"/knowledge-medium/src/utils/memoize.js\":\"21938b716f85d5ee\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"374e37a3036b132e\",\"/knowledge-medium/src/utils/nameList.js\":\"5f4790fea84bcc43\",\"/knowledge-medium/src/utils/navigation.js\":\"3ecb4c411dc14036\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"ff37f5a941058d00\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"45354894070af2a1\",\"/knowledge-medium/src/utils/panelClearance.js\":\"86b255715715272e\",\"/knowledge-medium/src/utils/panelHistory.js\":\"588bd903b8d00b39\",\"/knowledge-medium/src/utils/panelLanes.js\":\"c07642c419cc96cf\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"0fb366af502f422e\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"a6acb4831d9a3eea\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"eadbf9ac96d1b0c6\",\"/knowledge-medium/src/utils/platform.js\":\"1bb987a1953b981d\",\"/knowledge-medium/src/utils/pluralize.js\":\"08e532db8bc7251b\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"f7810d5785248617\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"bd0a7ca56cda31ed\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"90608d499b7bbc0f\",\"/knowledge-medium/src/utils/react.js\":\"843f8f66ea831bb7\",\"/knowledge-medium/src/utils/relativeDate.js\":\"4bd550176ed9734a\",\"/knowledge-medium/src/utils/relativeTime.js\":\"5b29bfb9379752a4\",\"/knowledge-medium/src/utils/renderScope.js\":\"8fde9700590ec446\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"e77f1d4f93d1606a\",\"/knowledge-medium/src/utils/routing.js\":\"82cc68bb74a09819\",\"/knowledge-medium/src/utils/safeMode.js\":\"58ba82092171e313\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"0efac8c8a9f7ea35\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"f82f4ea6fe8012d9\",\"/knowledge-medium/src/utils/selection.js\":\"56ec67627b5e45ed\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"4284d21a3a2b069e\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"ab51312b9ea5d445\",\"/knowledge-medium/src/utils/state.js\":\"49476e01368c3450\",\"/knowledge-medium/src/utils/string.js\":\"cc5568c9f95e2da9\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"c8a074834fd6d465\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"ec0fd7414fafd9e2\",\"/knowledge-medium/src/utils/toast.js\":\"0fdf7d16a7ed9fa5\",\"/knowledge-medium/src/utils/toggleStore.js\":\"47d01117fb587582\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"0814c12ab7399094\",\"/knowledge-medium/src/utils/userActivity.js\":\"7e19f8458d27679b\",\"/knowledge-medium/src/utils/viewTransition.js\":\"7af834892d9ccc40\",\"/knowledge-medium/src/utils/viewport.js\":\"ba6d56ef9830ac1a\",\"/knowledge-medium/src/utils/webLock.js\":\"a671858cc5182bdf\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"fb1481abd356ad63\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"1bcc229380c5f1da\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"edde4b51f377f150\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"60a1e2ceccd0a823\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"bf66439ec8ced552\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"67fa87ad9f70e2b1\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"f7c51c3d0d1a452b\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"46cb470677abf9a7\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"4334a99f2fc0e496\",\"/knowledge-medium/src/vendor/react-dom.js\":\"853fcfa3b1691523\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"d834790860532b44\",\"/knowledge-medium/src/vendor/react.js\":\"5c31e373bbd55a70\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
