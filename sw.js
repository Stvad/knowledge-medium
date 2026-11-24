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
		buildId: "55e59264b7cb-26d591b4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"a8655321f39bb7f0\",\"/knowledge-medium/index.html\":\"a8655321f39bb7f0\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"141c7ab4732fe1ad\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-J1HkG0qB.js\":\"09b8b470b4708775\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"08ad4c3dada7c046\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-7rzu27pt.js\":\"ac57b4d71fa211cb\",\"/knowledge-medium/chunks/FacadeVFS-DFlyndnx.js\":\"134e02c726bfe8ed\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-ByqGj_bi.js\":\"cc914ab322de62f9\",\"/knowledge-medium/chunks/MemoryVFS-C1xgNZvR.js\":\"1f3a83f8d04abf43\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DEjcInsi.js\":\"a03375a660387db1\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CVj-3FI2.js\":\"838dd34c47651aef\",\"/knowledge-medium/chunks/Preview-VgbZs5w_.js\":\"3bb6c23a19dbcdc3\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BgIMk8Ff.js\":\"8c92027068e0872c\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BZE6pE7V.js\":\"327cb03866e9b755\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react--VC5hjLY.js\":\"da2f452a68698ac8\",\"/knowledge-medium/chunks/react-B7zAl59g.js\":\"1e175e81f2608780\",\"/knowledge-medium/chunks/react-BJd0nh-H.js\":\"da6b98e676884a1f\",\"/knowledge-medium/chunks/react-BTNaP84I.js\":\"e56c8ac78504ae74\",\"/knowledge-medium/chunks/react-Blx1lQgx.js\":\"74b35ab3cc6c5873\",\"/knowledge-medium/chunks/react-CnLjXGJP.js\":\"fb4c989b4e5aa679\",\"/knowledge-medium/chunks/react-DZG7GeNt.js\":\"2e80a48d211b9cb5\",\"/knowledge-medium/chunks/react-YBGfZfxk.js\":\"6f1738d1176e19cc\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-B8J_-Fo0.js\":\"1cc852e1442cd024\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CV0h1WCl.js\":\"9105e37e4639a8a5\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DrhRjyK_.js\":\"ae74d2adf2597c03\",\"/knowledge-medium/chunks/server.browser-JajQWzOb.js\":\"03c83adf61e0aadd\",\"/knowledge-medium/chunks/textarea-DRSOmZUz.js\":\"2676d88d28d20cec\",\"/knowledge-medium/chunks/ui-FxAN4CHH.js\":\"c301eae480a5b22a\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"1a2b9a89fd3a3bea\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"0a086f249672a5de\",\"/knowledge-medium/src/appUpdate.js\":\"9c4f55d076e7ec57\",\"/knowledge-medium/src/appVersion.js\":\"f514d619ec2d6352\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"539585b631fe2573\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"837814b2302fd207\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"64640f9bd2422656\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"2cb4eca72d45b78e\",\"/knowledge-medium/src/components/BlockComponent.js\":\"9ae6fb4fbbe3f195\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"10e16827cf864d01\",\"/knowledge-medium/src/components/BlockEditor.js\":\"dea344882ee221d5\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"a118e423273577ec\",\"/knowledge-medium/src/components/BlockProperties.js\":\"57c5cc6419da9f38\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"876539c8d61a3c20\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"9ea3e22658eb714e\",\"/knowledge-medium/src/components/DividerHandle.js\":\"b640a44681f151c6\",\"/knowledge-medium/src/components/DraftEditor.js\":\"d349156645d994dc\",\"/knowledge-medium/src/components/GutterPill.js\":\"c93c69d149221487\",\"/knowledge-medium/src/components/Header.js\":\"1d549e930dbc3dcf\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"7cce80ee9e63c61c\",\"/knowledge-medium/src/components/Login.js\":\"973b1f1da155bae8\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"5bfa893050a67682\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"0d9e3dce3cd52d99\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"37cabed7b7ebbbbe\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"31919b5acebd7b4a\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"37a82239624313f9\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"8e509c2059e5a8b0\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"eedeb634493ab00c\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"e0b3f509e3a8db98\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"f7338ed0bdb61f2e\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"fad047a8a0a3c3f8\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"9b8ab51980be648b\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"d83dedcb645206cf\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"71e15cbf545928ce\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"0ebcfcb1d4c5c7d7\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"a96d5beca16b2b1e\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"556d204068d0d03b\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"b2a9a37ea83983d4\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"8b1cf493e0ca7812\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"7073609a303ba2a0\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"38cac0a95c22d90e\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"c2ad9caa54fa173d\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"8477d2eb66885a16\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9748e4de2d0cd0de\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"c5c96e983071b238\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"bf0107877ac9071c\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"853aa743b99c0095\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"992d30d4cc1a43f3\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"05cb5e4583adca2f\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"c174c34490d0aa0b\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"bb33f0561d043107\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"8eae550a3d08b057\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"90955bff1e8cc489\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"97fd15a111095302\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"c5689d0c2702bbe8\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"f08fd60368a80034\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"8a4d11a271106b8d\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"24420f69de6c5bdb\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"72223dd01705677b\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"e2cb51b4f88aa561\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8282d83abbea07d2\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"475623d99ca068b3\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"dbec85acdd0854ac\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"64a53eb040d3a87c\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"fbd3516bf9a32439\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"7bf51f013751313b\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"e37a5e573b456b92\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"1f8cb84b40af073f\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"adc68ce5680441c5\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"41784ba9186d2840\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"16afad437df99c37\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"fc5fc34d179eab4f\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"cf65e22084cdd0f5\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"ededba5976ba8690\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"39f540705b5f2c92\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"37c7eea55359b954\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"e3d3012732c92921\",\"/knowledge-medium/src/components/ui/button.js\":\"9ee07b0ceb097089\",\"/knowledge-medium/src/components/ui/card.js\":\"9520f8bcb20250eb\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"e315b978fa9585fb\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"b7d1380a630b0465\",\"/knowledge-medium/src/components/ui/command.js\":\"b8e512f500e4c628\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"06b52e1453a46d61\",\"/knowledge-medium/src/components/ui/dialog.js\":\"3266632344e59b43\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"66897aa97a6fd5da\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"8a48bc3f2a914504\",\"/knowledge-medium/src/components/ui/index.js\":\"166a126cf69cbb02\",\"/knowledge-medium/src/components/ui/input.js\":\"a461807fcc013f02\",\"/knowledge-medium/src/components/ui/kbd.js\":\"be22913371e5d203\",\"/knowledge-medium/src/components/ui/label.js\":\"4db22eb870186ec7\",\"/knowledge-medium/src/components/ui/textarea.js\":\"802168fd5f8c030b\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"afee54cc0bef98ad\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"0a1c67a64b549513\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"81d52abc310ce04a\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"d6cb281c077ba9b5\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"25dc8446410350d7\",\"/knowledge-medium/src/components/util/error.js\":\"c7daa260d312d3c1\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"bdc0c4971d355f8a\",\"/knowledge-medium/src/components/util/suspense.js\":\"aeae4f6f2c7ec203\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"6be53d978ff4cdf4\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"f744a327d26784d0\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"aba6d0581681b01f\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"0b6980d8de1cbbc1\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"809038781f50d468\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"627283418dfc83f9\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"a54b010c805f1cad\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"876f5ad4f3f7e361\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"15a9377f4c6c6ff0\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"799cfea21abaf054\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"0bb40d2fdc4dd212\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"33d4a84178cc11a3\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8c717da3fbdef2f3\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"c361832e94429c1a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"36b32ba4952f8a48\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"08d42cd7ab85dd96\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"63bb196acf444e97\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"84c38ab15d5cd383\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"340b40b1855a66e0\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"43e2610661575ca9\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"2c7e64b7fb1de33b\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"55c0ace6c5c9474e\",\"/knowledge-medium/src/context/block.js\":\"661aaa419b4b69de\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"f8bb59a1aa5745c8\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"10b20f46c908ec14\",\"/knowledge-medium/src/context/repo.js\":\"56934359fcc8bbea\",\"/knowledge-medium/src/data/aliasClaim.js\":\"cb6ea60ab1f65b3e\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"05a7c080b63274f2\",\"/knowledge-medium/src/data/api/blockData.js\":\"0deb04d8014fe3a9\",\"/knowledge-medium/src/data/api/blockType.js\":\"a391df77b31a7324\",\"/knowledge-medium/src/data/api/changeScope.js\":\"e279991a8fa153c7\",\"/knowledge-medium/src/data/api/codecs.js\":\"f07df98d36992389\",\"/knowledge-medium/src/data/api/derivedData.js\":\"e5fe09cd42f044e0\",\"/knowledge-medium/src/data/api/errors.js\":\"ef2e09942454fef8\",\"/knowledge-medium/src/data/api/events.js\":\"db3efcd21213bcff\",\"/knowledge-medium/src/data/api/handle.js\":\"af2cfb9abb59fac7\",\"/knowledge-medium/src/data/api/index.js\":\"bbe8566b0a98fee1\",\"/knowledge-medium/src/data/api/mutator.js\":\"98171a7e6041de1c\",\"/knowledge-medium/src/data/api/processor.js\":\"91ac7dbe4808ea2b\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"972310fbcb3d71fa\",\"/knowledge-medium/src/data/api/query.js\":\"1c48c951a9b1b123\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"daf39327db2b3239\",\"/knowledge-medium/src/data/api/schema.js\":\"af2cfb9abb59fac7\",\"/knowledge-medium/src/data/api/tx.js\":\"af2cfb9abb59fac7\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"813dba049dfa1b3c\",\"/knowledge-medium/src/data/api/user.js\":\"817e4be256d2e00a\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"d772ea8629c98ec0\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"8e1c11eb15931870\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"d63c6e8dfe373d50\",\"/knowledge-medium/src/data/block.js\":\"c768c435e3702514\",\"/knowledge-medium/src/data/blockCache.js\":\"beb3ad82fc3a7dec\",\"/knowledge-medium/src/data/blockId.js\":\"97476faf7370e5d1\",\"/knowledge-medium/src/data/blockLiveness.js\":\"78d62dac5fd3da28\",\"/knowledge-medium/src/data/blockMerge.js\":\"167d7a0e0158f86c\",\"/knowledge-medium/src/data/blockSchema.js\":\"f1d13241fd5756fc\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"b09fe93c71a435a3\",\"/knowledge-medium/src/data/blockTypes.js\":\"cf07d1b7eecab8fb\",\"/knowledge-medium/src/data/childrenView.js\":\"74e49cdb262f8072\",\"/knowledge-medium/src/data/clientContext.js\":\"d3c5be42252e4911\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"c3c9f3bf0bd86c63\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"e9200469dd23f48d\",\"/knowledge-medium/src/data/derivedIds.js\":\"5da3fe2036d50c66\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"407202c7fd7b6f45\",\"/knowledge-medium/src/data/facetBridge.js\":\"f08d797a162cd196\",\"/knowledge-medium/src/data/facets.js\":\"492058809eba018a\",\"/knowledge-medium/src/data/globalState.js\":\"cc5c28cc11f6b8c4\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"872c13a294eeb0c1\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"902eb2649c5f7cb7\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"a78b088e52de240b\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"c174e5c7c181ce2b\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"5d7eddf650d6d6aa\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"18617d084d8ba9b8\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"99889752a2a1d40c\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"3929943fb69b6ca7\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"a0ef3b7fa30e4f9d\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"e69608f73204e312\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"0f7b7528e9bca123\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"33a00d88bf466aea\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"8e5cdb24cb4757ac\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"a82a60c1ac7e5c4c\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"7533677d7715a9a8\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"46eceaa527feb1ba\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"76627d6309e53028\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"b4c38dc707578576\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"fff592dd45ccbbc5\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"aecca14cd5566c0d\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"b5869741d383daa6\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"34071fe1d286fc50\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"86b14812d8d17b85\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"102ff05e8297ef1b\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"aac0acaafb5434c5\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"23afdb8fb1c83c60\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"65280c789dc23dcb\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"f4cc54f35e0dbb50\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"de9341ca39cbc28b\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"aec98876b5ee24fa\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"11e39a2deb71087f\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"62fd3f7ad27a4ed7\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"2a70e4303a8885d1\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"cc75f1a415d2ec04\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"a865a0300c8534ae\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"c9085a691fb42d4d\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0db8c4a4f1d051d3\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"d67793c2b15af010\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"88ac256b7d41de44\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"406a79843405a88d\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"41b0bc2b3ab44f11\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"a40814fd5d209f88\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"e5bc8b42011a6c9a\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"fafb163a97d67281\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"01e3e4b715a0f0f6\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"db5521d4ffe84dc6\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"01da88249538ab3c\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"173d2b7c5c65e1c0\",\"/knowledge-medium/src/data/invalidation.js\":\"62dcaea99411728c\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"a794e54488c13634\",\"/knowledge-medium/src/data/kernelPage.js\":\"846f3665c9b27102\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"8ed49901a539a1da\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"9d2b697dbf87c51c\",\"/knowledge-medium/src/data/localDbStorage.js\":\"cca9ef071bf5102e\",\"/knowledge-medium/src/data/localDbVfs.js\":\"43d348ea30d97354\",\"/knowledge-medium/src/data/localSchema.js\":\"227d636bac515bac\",\"/knowledge-medium/src/data/maintenance.js\":\"8548936f1a59249a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"8155dbc138695525\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"881b454ec65d9a97\",\"/knowledge-medium/src/data/migrationsPage.js\":\"e499c56125e7ddbc\",\"/knowledge-medium/src/data/mutators.js\":\"4096eeafd3007ff3\",\"/knowledge-medium/src/data/orderKey.js\":\"e48c5397b2a990f0\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"29fa6d87aa662717\",\"/knowledge-medium/src/data/outlineSurface.js\":\"07bc0e3d755dda78\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"3177798f84a79d59\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"2bec125ffd804c02\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"5d1ecbb7716fd3d7\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"dd2d84708ca53377\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"f05b6e94260d9cb6\",\"/knowledge-medium/src/data/properties.js\":\"c6d712cdc71b9789\",\"/knowledge-medium/src/data/propertiesPage.js\":\"9e19c3f00619bd5d\",\"/knowledge-medium/src/data/propertyChildren.js\":\"407d811edc9cf36f\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"6cdc7c4a1724c5d4\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"442315db6714ddad\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"840662cbd4290d5c\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"e8f98cea4c8a4332\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"0d7b0dafab96290a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"fa0ca4cd2634be0e\",\"/knowledge-medium/src/data/propertySeeds.js\":\"fcbcae85d6d8a23c\",\"/knowledge-medium/src/data/recentsPage.js\":\"c091fe4b47f5b59e\",\"/knowledge-medium/src/data/referenceBlock.js\":\"b28bf1fe39451987\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"c953df2478e7c5a2\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"319b28bb40f14a0b\",\"/knowledge-medium/src/data/repo.js\":\"df63f56b211d0089\",\"/knowledge-medium/src/data/repoProvider.js\":\"7e988d46131c0fc5\",\"/knowledge-medium/src/data/rowProperty.js\":\"6df147f9d07f323f\",\"/knowledge-medium/src/data/searchFilter.js\":\"9651c6cefcf2c0c1\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"d3cbc3f60c8e1ca2\",\"/knowledge-medium/src/data/stateBlocks.js\":\"6160e6900ea98c5b\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"f629a37c2d432da9\",\"/knowledge-medium/src/data/structuralInsert.js\":\"a76757cd4c658cdf\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"8f6bd31be4f1c3eb\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"3764003d91d8b8cf\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"627b0a26675b49e8\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"8d41fca186c9b73e\",\"/knowledge-medium/src/data/targets.js\":\"ea325e3caa2cbee2\",\"/knowledge-medium/src/data/typeColors.js\":\"a3ddfd376927ec3d\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"a4375316e89c374b\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"8cb9ab8b38dd9de1\",\"/knowledge-medium/src/data/typeExtraction.js\":\"412a18a87bd0678e\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"1c0ee93f845f4403\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"c1f675e867878e6d\",\"/knowledge-medium/src/data/typeSeeds.js\":\"68e15b467a98e1a9\",\"/knowledge-medium/src/data/typeTagger.js\":\"5bd0ab2d6aa657a5\",\"/knowledge-medium/src/data/typedRecords.js\":\"66a9f4a69a9a5702\",\"/knowledge-medium/src/data/typesPage.js\":\"dd98c79fb763dcaa\",\"/knowledge-medium/src/data/userPrefs.js\":\"4793cfcf80581310\",\"/knowledge-medium/src/data/userSchemasService.js\":\"1689fb6c825c4d51\",\"/knowledge-medium/src/data/userTypesService.js\":\"025e0ca08bc30b1b\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"87ac8c9ebb35ac94\",\"/knowledge-medium/src/data/visibleChildren.js\":\"fef36e0cd554dc8e\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"0bc4dcb8cbce706d\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"dd21ceea5f104d0f\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"901c6680c58596d1\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"41a634b1f519afd2\",\"/knowledge-medium/src/data/workspaces.js\":\"2d86e87cbca193b6\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"f5920823bdcc372c\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"3bc2cd6554bd96d1\",\"/knowledge-medium/src/editor/atTrigger.js\":\"431f7301ab0a61e5\",\"/knowledge-medium/src/editor/autocomplete.js\":\"137c15c0046b70c7\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"35a27840a5597982\",\"/knowledge-medium/src/editor/contentFlush.js\":\"9ac3cd579f42f296\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"bc9ece8fb2f90f31\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"b9c79a185e8da732\",\"/knowledge-medium/src/editor/insertImage.js\":\"e8922ea4b732f32e\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"da1a1faf05c8d7e1\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"a095434df6011235\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"395894f00fe24577\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"cef85636f50be7cb\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"62ab6049a6607960\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"77aaa923ffe6b9a9\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"0aaa50b8c515b6a9\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"7cd3b3b525b5cdb4\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"2d0d3f0080792972\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"a44bc96ce5a03abf\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"222be45c9dc209a3\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"b7c24dca98e837ed\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"61c10a577bb1b307\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"e118f9e2e9c23f1a\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"2986425f9e530811\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"f0a15cdf261f28c4\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"65515a4ee7ca1cf3\",\"/knowledge-medium/src/extensions/core.js\":\"3ea51d39c1bf7753\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"edf46a5630fded6b\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"09283b04c4df05d8\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"c3f6f9b26f4f76ba\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"bda2e3f760f64e92\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"7662b4026c9dceca\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"9f386a2e44951562\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"5024b87a7631fe8a\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"44f0ade325daf762\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"8da17ea7eafca14f\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"9978ed51a4ba42cd\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"8873231925dcf552\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"ffaff85e07490f81\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"ac0d06b84da4e82b\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"4fb4d6c08524a505\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"31b32355f39cbd42\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"0e9ebfee686cfe1f\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"dc8c856fd0ba11ed\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"ee5c1fb42a133400\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"5d694e75419b7b02\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"8abe4ad6cd89cce7\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"4dcfc53c21734a71\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"2cf63c3e06119ae8\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"e8e0610821642236\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"9bf5a8674fb25dde\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"ec9e7e6193168f0f\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"f9c818f546a433dd\",\"/knowledge-medium/src/facets/facet.js\":\"998d1957b1b88867\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"5c3261cfd6ba6966\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"2ad0731282f4b3a2\",\"/knowledge-medium/src/facets/togglable.js\":\"d02d14df622c396c\",\"/knowledge-medium/src/facets/variantFacet.js\":\"89962998e1c7c12f\",\"/knowledge-medium/src/facets/verbFacet.js\":\"ac97c5f001e16413\",\"/knowledge-medium/src/hooks/block.js\":\"3e8ea177112d8d62\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"d703aa1bbffd2f3a\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"a7e2c9f0f20e4345\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"67d04d2efa245835\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"01725d34a803d482\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"4de372f780081b87\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"4f3d23e58b970a80\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"310230afd91eb577\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"d4f45ca4bd813c7c\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"510370b664ae0d6b\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"c6fd2a632b9cb65c\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"c59bd3c6f601a387\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"930091e3a7dfee6e\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"6781589102252c87\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"2f587e4cdca0c169\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"f76f4cd567912e74\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"7876cfd56e42a3ea\",\"/knowledge-medium/src/lib/utils.js\":\"2034b4a931df7e71\",\"/knowledge-medium/src/main.js\":\"61d89e2e08db903b\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"caea13c361d9d3c4\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"563ba2a44c05b887\",\"/knowledge-medium/src/markdown/context.js\":\"73c91315f1db5213\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"8561f43a3f63cec6\",\"/knowledge-medium/src/markdown/extensions.js\":\"0e74aab826bcace7\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"6f47e6edf61c4f4a\",\"/knowledge-medium/src/minimal-editor.js\":\"7808b869c74281b9\",\"/knowledge-medium/src/paste/armedCut.js\":\"327f6ac42e691851\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"ca16340cd9b69309\",\"/knowledge-medium/src/paste/clipboard.js\":\"977c2308182e4f77\",\"/knowledge-medium/src/paste/decision.js\":\"1589d1036630a5b4\",\"/knowledge-medium/src/paste/operations.js\":\"df3a57591b5b1c32\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"57b321fa1cdab247\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"3881bc40e5a78d1b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5d95d20269dff0e6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"a1ee354f96a4b259\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"8ce74412f6885250\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"06f76404d9b08486\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"9a315aeeaf939602\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3e20e5e65064319b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"d14dbd3f95b71683\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ec82f2f7cc0a26e8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"09d0d49e08a1df28\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"36c895d5f81e8eee\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5f2861f9e80ecf1c\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"b73fab6c79d7c971\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"94be1665062a30b8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"a1d18d759869e0e4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"f5ee88f1e2af28a1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1b4bc40db94907e8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"d854a60c4f9a14cd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"5aef5ee782109553\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"ad5cb92668dba7ea\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"7e09675a43418961\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"73b5894d0127427d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"88e642868df33063\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"6e759ac57d6d23e6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"40d057a6b999f690\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"adbdf4cb09854eb8\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"50bc29e0f25ae14c\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"561ff52eea20181e\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"4eccb955c3f38e96\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"7e592f6beb25638f\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"83f5a21cef44a220\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"ba3f3d3345857b92\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"2ad01d1a9a789e0d\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"7dcb8ce0ff4f4e85\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"ff994aa1a29f5ac3\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"11f227b3441e7e8a\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"c788ee0a05073cf9\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"6fd6e8e40c648a3e\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"48dacaf8db38836e\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"67ea596c0debba59\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"840caf165d0dcbc7\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"e778c0ef08e3be9a\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3bf7e21efa81b762\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"1a907adaeac6121c\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"f0fa1d6dd6092591\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"b94687e824788537\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"bdcc2e9bb32ad222\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"1f444ee3bd1443a0\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"47599c9d109ab861\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"159478694976bcbc\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"56d5e3a1604f26e8\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"a99af4e6023e16df\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"b2986f354fdbd5bf\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"5c6974e0cf605be1\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"7327faa65cfc8c0b\",\"/knowledge-medium/src/plugins/alias/index.js\":\"6f74f8c7894d1c3d\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"1922e362eab11fef\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"fdb226c0d874f519\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"f6b410544c01397f\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"9ba11253bcdb1c3e\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"dbaac072e4eda739\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"e99951a1de39161e\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"67b0f27bacebf02f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"269c41210cb1324b\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"576a9bfb89434bbb\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"2fe90aa8271c3d4a\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"6620806bd4a26e2f\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"106c60a609a1cba3\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"ec17d53ad50823e2\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"9e6f8a55d5dceca6\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"d469b28b096ac064\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"e1d0980edb96453a\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"e6ee7e87b3e8a1ae\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"05b54298be839f2b\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"151469da5e16ff29\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"eb2bcca7311f7d79\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"978d43949c6a0d23\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"6cd054a4adb1ac3d\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"964f2b1656fa7f1e\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"bee763acbda86f2c\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"a6b8534418eef355\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"e97d50879ebf8cab\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"f0d7337f8de31c78\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"85e09fc624790c9f\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"7c2c6c937e71e94b\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"26b36ca29821c188\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"ebf2d9c14e8752d7\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"6d10beda5fad4490\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"7035b3051b3159a1\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"2c38252ff71e724b\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"1dca34b0bed32ec0\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"0e55bad6b6631814\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"c69a6667fb8be1f7\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"36c977b979e07c38\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"989767a213b8cf59\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"c441738b47956354\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"d21e50ae189a3330\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"b187606b1ae02b44\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"ffd39fbe7b54b1bd\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"258168dba29602ae\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"5cae2944d4f861d4\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"46a024d471fc5ce4\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"536375a819d3d89f\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"51988031b47ccecf\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"44cd667c6431ac40\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d10ec2000c02eea0\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"0c3412b23ac26e8e\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"fa7711c797f77fc5\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"b1c747bed47a85dc\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"30f871c67169dbf7\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"31835825606e9ebc\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"25a166fa98e0af9b\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"2e8d0992fc88af99\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"22441f8741af4fbd\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"4affc051b2302e2d\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"4f48d38756196582\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"de9c0455d2f3a0d0\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"ad13710d87aa3dc9\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"23ad70341e8d9f78\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"ddc7da34d71da12c\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"1d5deabb8159dc14\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"cf00334ee31ddacd\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"62271433e83abff9\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"fac4e27c5784fe19\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"c350fe46c3a7cf4c\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"efe418947d98b17f\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"f85dbe8d2eb86117\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"826a2c30901dae14\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"886f4f6c55aff713\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"a9f7829b099b269b\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"929f03cdbe6666a5\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"f70b957cea34b156\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"31cb04735893ae1d\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"edcfa736126d8467\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"4d76694939822914\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"eb69e102c462cd7e\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"0874f1e0d6c4c503\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"50a3b68bc2de4dd7\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"2aadf22258ff5463\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fb7b7ca906bbc6c6\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"0fc29a2f1eb4387a\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"40da17dc2e52ad7a\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"ba8d12dc5def41b0\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"840d5368b179c81f\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5dbfe1d6ca6b3817\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"1e88e6593e2239d8\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"76393a89d6cd8a70\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b6d2f7dca379b5da\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"c005eab6fb047490\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"cce3b209994c9908\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"0b6a42714fb53511\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"810b05cac6e201da\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"654f01551aece766\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3d2c395510615221\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"c220eda173997e73\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"e2ebd0de6dadaa2f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"acf17a2e369c7b19\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"ab35450c84224135\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"4ab8ff90b413793b\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"068c7b9a6a12b275\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"0f382b13844fa987\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"8f38edbc5a9579fc\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"a4fe02379d16bfda\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"298f5365079036a2\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"40322798a4a19c25\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"78b8436f581a2e6d\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"a6eec8a5584cf7ba\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4f89491eb5dbfb30\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"21ecb104b4db6744\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"00f24123f3631c55\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"5ed932435c457fd1\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"720a481670233873\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"3924c3ea15def2df\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"ded459e42d7eacfa\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"9651b8c6e1a2c926\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"29d4cecd3fcc1b1f\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"4a937eaac284e876\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"487927aebd11a011\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"625aaf34b7bd6c78\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"0418ec8a1742eb27\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"3bf972624c514d99\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6dd1d3cb277bd480\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"a09660aac18c20fe\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"e568c3e971ea29e1\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"e1f83126f0c3c0e5\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"ede4d72fea0625ef\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"ddc4bcd6eaa4644a\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"747a602f35e5d656\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"1bab01ee51e971c3\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"bee1be33104d1271\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c4b03ee13044b456\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"dd574f56ae586fe2\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4eadc5a4dbd190a0\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"580d3a453de5fd8d\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"1bb04e62dba21d6c\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7def5e9ca96dc5ca\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"e5d6c0ec92f0c953\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a1f343f99ba85129\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"ce95a900bdf6cb7b\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"404fa396cd1931e4\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"7fa2edc0829008ed\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"884a26e41d644805\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"3bf7bb58755e9a7c\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"6734316679261467\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"f887125d202e33b0\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"dccaf4fd48fcd9f3\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"31e205c4e046ed59\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"ee8c74c1c66aa788\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"f533bf122952fb65\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"9f5f592dc42891fb\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"d3a9a9f5dbc42ab8\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"33aee249dacac57a\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"17def460903acf3c\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"f19f58251454c54c\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"056fd94296d39160\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"5c02454c3cde785a\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"17a380f87703b486\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"5e0310a11d31df7c\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"a3524dd0ff3bce7a\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"2ff52ad13eb487e9\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"af73bc8785776115\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"7ba54b28f6874146\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"ea015945f5749c38\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"7a9310d665812806\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5709dd9bb0df419c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"74df89ed5b2a4c98\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"9b1636b08d5beec5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3efa5f3063231800\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"02aa74625e6f8e14\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"a7f09d7f5a429717\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"354d1f182f76813b\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1ba50cc6809eb78c\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"931d96bd60411696\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"10b4bfcb51141a42\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"f43011759acbf2c4\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"84d184892056ea9e\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f4ace7e601889a86\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"66a5dbb0b3970e26\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"aa20bc6bbba083bb\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"a50d7eef9c3521f8\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"535c33329e699fdc\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"f1057345f6d26ff1\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"b44fd7f64612502c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"dfb6ce768a4b5806\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"54ab07b53f42d8fe\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d9fd6c3f58997cf1\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"be604c18b44ad7c4\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"762aabc0ca2b1865\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"9610a715a5b87978\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"3491002edd8830d0\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2f5124e4e3eb678e\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"95969b04b513fabc\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"ad0f023cb13e2620\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"46610cc7b17e53c2\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"4ec427d541278d64\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"244e2a06c967144f\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"b2cdad046e0825ff\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a66158943053a9f0\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1ddf9be781682d5c\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"dcff15b0cd2788f9\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"075879d7ae20aff3\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"ad86e03ef98b03b6\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"2333c30df0d71ea0\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"3c6fc873325adc24\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"d0885e35f70cf2f7\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6067b2d217bb1a9e\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"eaa08bfb941b3a3a\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"f49b864490911876\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"35ffbf6c6f5eb9ee\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"109974370d979eaa\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"225fa91ffda3cf54\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"2055e86ea2dc4aca\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"4fcbf9b00d4be1fa\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"dc77ac1534aca834\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"1acdf667bde4827f\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"d9370aa58edaa561\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"3c6e865fc65e1fb0\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"1946c57e0179c7ef\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"06453335539486f8\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"624b90ce6263fdff\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"695d3ec1d3c91b72\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"3615c36c2c458c53\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"c8a1d7564f577e92\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"118d967d025bf9d6\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"e858e36f2ac58fc1\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"f3d0d3de6bcafeb7\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"4b7030d7e8679d3f\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"69df8d060ba671e6\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"89932e4d9d2d910b\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"ee19af800617ecc3\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"3c371595a0580eae\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"8e5e53121e261cc4\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"9ced32d5f5264a41\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1bc8e32ad8e13030\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4537eebc33231018\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"5d62c607e26ea779\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"111038253140db21\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"488b8a428b6e99df\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"c88a043043d04d22\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"237c44e3b90363ff\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c4c2d957af196018\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"88120020ef8becac\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"c07004106bee21ea\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"8e92c54c8f8f3db4\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"3aaf446ac9aad2e9\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"1313a48ca7aabbd6\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"eea11b9c633cfecb\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"8955f5e069b395b9\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"503d4fe17528e87d\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"948a8054a6c9ef7a\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"a3b1adb91b65bf88\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"241ea16efa29ab33\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"a9627904367d07e1\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"ad43f74bb5524681\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"6f9dd7565d6bc591\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"c49f87ee5d7c9f51\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"a295a4eb0e737139\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"6856441ae10d98f5\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"35dcf9e23738a694\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"cc21af64320c54df\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"275ea613f3e6ad69\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"3d83de4ade34eec8\",\"/knowledge-medium/src/plugins/geo/index.js\":\"2609870aacb29d8f\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"681d5490f7c82668\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"24b530522416a19c\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"458b252f84ccac47\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"7fd29c5bf9b1c070\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"615dc8de65966ed4\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"7c86b2754faca63f\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"b0ba8a867e2b1963\",\"/knowledge-medium/src/plugins/geo/query.js\":\"9ff31ec78e154434\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a9d48a18400008ed\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4950334135f22302\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"24c0672def27e359\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"33342da318f33a60\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"5da1fa56fc9fa46c\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"9d8c81dcd93f592b\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f043c559471d4cba\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"445228958b2090bc\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"10f7c3d1e7e43624\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"381961e3b2c2aca3\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"bb61a7690237daaf\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"9c759e7c713062ac\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"06abce57eea07b8b\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"764399ac854305a7\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"7f93f1bfaae5e3df\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"5752a646be9c331b\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"ae47ca53a0cc66ce\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"9a35251de2f91393\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"d872faa9a682ab69\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"f238c501f2809d5c\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"ac190905aa2e9421\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"b2b2b5b3916e8f36\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"dbc35dcdb9f648f8\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"053ff7232f609029\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"297a1c8ad119691a\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"a11bf09196cce410\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"b43877b265a2dff7\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"7292a6b994d62681\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"a684b3b9f00ee614\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"a212c42c51cf0d34\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"d2b0a4d07c5ad80b\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"70b5b7b7667916e0\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"35c781e5e76c5c81\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f413111904c1a140\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"768abcd0f30748aa\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"8a7876ff9ab0b9da\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"3d6c1bbcd98c9dac\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"a2b1ddc35841290b\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"c2304b53653212f2\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"2e42e2b5f1f4b392\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"124832e5bbd7582a\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"d9779f15c00c818e\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"2e7b370d7d53099c\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"c8c05cc57dff5e28\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"a0df3178c572796f\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"2c71b69177858474\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"7940549ab48da04d\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"b3c82bbe67dc7c46\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"55427223db049472\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"fb5b0e119d40aa93\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"e220bc4ba8c1f26e\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"3d5d4b143526866b\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"a9511c88b5106a9b\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"58bc984a3d5bbb03\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"bea8e56d176e5f58\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d7d60e2ef316b9bb\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"896170c3850d323b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"f38c54e99c4d990a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"8d9f58698749dff8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6119f920d6c4c5a7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e7a9c7529fb3300c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d2cc78832f726948\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6339e5e93214b3d4\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"bc0c9a39b021c2e1\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"af4efa0ddf5ce662\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c32fe25fd08cbc38\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"0d36dfa32f970e1f\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"1c3d94c2ec7c79cb\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"ed5cccc9ec17cf1d\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"536f74041db61306\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"66c7fca078340374\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"3599147773bbd052\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"7cecafa8403b616e\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"bb1a6e9a9dbd593f\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"40962b9c2ade5342\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"fe0b82685e68c99c\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"a38aeea3448557c3\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"fe2265561d4fdb9d\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"35f596adf0e5db4c\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"dc11b0525a42aa60\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e064bd8c3fc07e78\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"4d6ca59b788f76a1\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"c0045341f5c6116e\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"d77fb0b2fc9f0f24\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"2486cb2c7e640402\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"5585e802cf894694\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"5a48213b7e6b07c9\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"7b68f444937e6871\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"736c7e3a3e5f1202\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"48a744db2c610029\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"a41c2e2c8f9ebcb5\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"9036959889abcf73\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"f3bd8b25051925b5\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"52d115a2cf06af40\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"703943ef5ae54091\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"dea97fa22da1f6bc\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"0990611b162eb1c5\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"e5ca09682530f5da\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"fc5094dd5c7ddbb9\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"612d9c3bd0a440cb\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"ca013eea6b23d08e\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"6b1350cda321cd79\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"ab4a9c28673fc946\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"4cba0d4b5616f562\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"c23386120eafa83f\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"e9c97735b9847fe9\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"29e7b837388d48c4\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"15af23e0c98e724b\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"e57b02b363bb2e01\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"c56c95545cce5f53\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"067b45f3efd35df2\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"f8b42581e448e9ce\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"5c25003bcae9f977\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"4d9a77e5b2f38e04\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"7dc4ef62de2c497f\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"5056c5f8bacb7d33\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"42fe4b92441bd2c0\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"1d86c06c46ccfc3f\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"2818655ca773273a\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"9d2549329a51c6d7\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"329ffaa721c3c4ba\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"9916dc830f88681b\",\"/knowledge-medium/src/plugins/recents/index.js\":\"3011a16e09f44b0c\",\"/knowledge-medium/src/plugins/recents/target.js\":\"b0e459bc0c2f57bd\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"3f241fb4e345baad\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"222525ecad9fd4b4\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"569344ecd8ee3807\",\"/knowledge-medium/src/plugins/references/index.js\":\"b7e1ce6ea18f3593\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a0660a8829ff1b1f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"ae7380795251bbac\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"ac85b2821b4ae3b0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"c7b7fa5e6c4082dc\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3fc55fa0e584ef64\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"d594b452646bea2f\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"aacbac0fd3edb521\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6f535f7913ed0f9b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"893d0e068865e897\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"b12f3b6c10e6ce2d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"becbaf30ba049071\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ffec453811113180\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"e00f32d978678ddc\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"92aec68da875e042\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"5362f652abf6f195\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"f1d9ece64e152120\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"4fd3774550d06317\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"bff5c88e594db7b8\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"f6f55f00a4eaedd4\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"f527540f83c2ea6a\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"1470b82ec4bbf67b\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"08c193a47eea860d\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"b2985ca432425a00\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"1f5f63d54ae7aae3\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"8981ab6bf680ce75\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"31467283a2b62914\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"fc2674482476a494\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"d238e3d15fb69efc\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"0758075d8a843595\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"bfbfcbca8dd7564b\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"d5f7fac86f6121bf\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"03abb8161b7b205e\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"3f1042baf253f4fb\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"56b58974f9f92b3d\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"c048c178315da9f5\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"c1c70569698cf9b7\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"cec2d418d68c1033\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"59e979ee9ea968bb\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"30deb234fe7e25de\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"6f196b334cd4e551\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"53cc04a8dd56492e\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ab1885751a454268\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"def6f557f570068b\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"c2509c11f280ea39\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"d1ceb131e4b349f8\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"e409848b9ecf5ffd\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"46a924052e213b84\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"ee07f50cd6b62ab6\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"13c65d2c3da1155f\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"09bdf030ea963281\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"b3715482ad6b3f03\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"53134e37bc19144f\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"f7be80b336ac4abc\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"67ce3d4aeaaa8c70\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"588ab2f2e9d97856\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"f9198f554171f124\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"0d192d5b4c7a7479\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"5ae66df36a33e445\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"7fa10b441396908c\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"667052b9734edb45\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"f6bf29468930307e\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"9dcb30855370d306\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"5313798f5c79ab95\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"8495e87a396d82e5\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f26b9f52b92f5844\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"3b4c87126962c1f5\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"9506c562196ba78d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6ef965bb9caa1f70\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"929619c6e7b91ade\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"079456a025ea8259\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"74d8a5bf7bbd62bd\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"04d413e9243585cd\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"f0fdfe85966ab917\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"acc7d9172e9005a3\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"b547e7f439f333f4\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"ca37ce4400c25ca1\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"53adce1643e53b10\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"f54c59749d01c166\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"a4a462d49278f7c3\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"73894e89d936fc45\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"48418fff232ba250\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"6376f71694c032f7\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"d87b1270fd7334dc\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"3f802424b38cf2f7\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"39b3933afb65dddb\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"77d8faa5f319c475\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"f90b10c1a1f4802e\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"81797c4be66c453e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"f66d81cba076cc96\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"595fefdecb03e345\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"884c1f867873bdec\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"df200d5c507bd9e7\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"b230523b7046c8a9\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"75b817c862a98075\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"e65ca3ba6647edc2\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"58d11db34ec26fcc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"096d7c8f4f5be3a8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"28a8139b1515ac3d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"5b5eeec3a93067eb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"4d8d1067b6495eac\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"2cd7931b673fc255\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"1716580d47f89c66\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5212fd8bcc669f76\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"0ebdf18ac37224ba\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"54c5a3c38e3cd9ba\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"476b71ce1b11304c\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"cf384394c627e01c\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a4d21f1deb0bac6b\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"ac0f56fb07e2cd51\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"96c82774d1cc1ae4\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"199f4ab0d508908b\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"b27fb3b01be91dea\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"c8d46383effa14a7\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"03a7c02d1fe553dc\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"37076029e5db385d\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"8f4b53a8c0e6a6d2\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"e734e5a78da52049\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"67d55637406849f5\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"60189f7110a9c8d3\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"fc2ab59bfc9cac0b\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"2b18eadba368f2f6\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"d443d2b18c8b473b\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"057dc25e74f3d206\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"c3d9ce411318890f\",\"/knowledge-medium/src/plugins/tables/index.js\":\"6375c11fdac300f0\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"01bd5dca34788b56\",\"/knowledge-medium/src/plugins/tables/model.js\":\"83be0cb898f96c6a\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"90accd7fb0a5c3c1\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"b7e997dba2f9ca08\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"053818fb66797143\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"67e86297f1ddaf13\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"b9e197e8b72f5f6c\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"976e085e65965c97\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"7ad85e2306368abf\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"bba4042b3bc32e20\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"8701a6add0b90f54\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"95fcbd0c19c42420\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"431262b335caee39\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"ab2fb492c2b0ffc5\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"c720a929655ae8a5\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"474ccf26d8a20f74\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"2b2ae69b6c964f59\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"5f8f142f3ed8b6c7\",\"/knowledge-medium/src/plugins/todo/index.js\":\"3152b8810fc1fe0e\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"791fad401ddec973\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ffe49505e825444a\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"11374d481aa2161b\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"c919451d09900e7b\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"dde6b622d5fd550d\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"57391ca549a9558e\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"ae9272c93fd1bfc6\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"d34ac59c3e9df0b7\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"1f98588ce5b9e775\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"6c7209aa23af4737\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"91a4873d91405898\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"b8d80d83c51f2d8b\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"2f0263a14efc4219\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"bebd77dcf080bd7c\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"e8e802ad7b9f80eb\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"085d505e9eec6b87\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"b3013c893b70a470\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"837a1311084cfd7c\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"9d2b9f1a9a571b74\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"84bb870ccb4b5ab0\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"fec88d0e910f71ff\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"325bb68b136ba076\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"cb8640a476a70d32\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"f70e29338ad0e8f3\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"9a17b2534c383f1c\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"edc0c2d9bb74df6c\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"4898c63b5ec60315\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"3450f4c543fb61f5\",\"/knowledge-medium/src/registerServiceWorker.js\":\"b8eb5fed298f3c7c\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"ebc532d1bd94d4e6\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"a01d0a5e33b87cff\",\"/knowledge-medium/src/services/authStorage.js\":\"1f529affb66abe26\",\"/knowledge-medium/src/services/powersync.js\":\"ba83229db661cf16\",\"/knowledge-medium/src/services/supabase.js\":\"89b1d417a37c1d39\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"a71b9e18a1c792b2\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"5cd47e2642f2cad4\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"c22bac81519d05e8\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"0cdf36c361ce2429\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"31320bc215fe067f\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"acddb54347f50a40\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"0fed318f4cd38e15\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"8b183aa860152f6a\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"81b2413ab9d2d309\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"285c45d15a84890a\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3339d6e69b21c88a\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"d2ea91aea3efcd4e\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"bc76793025582ddb\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"4ac88cd1ad667fc3\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"4cb9dcdaf7381888\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"1bb1ff42d7ef8eec\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"02a9b2107c9f52f4\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"d0cd61ed9436ea71\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"986a791274b6d231\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"52d92b7ca5b5e920\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"4cdb62dc6b2f9d9c\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"2bb6716561a8ac7d\",\"/knowledge-medium/src/shortcuts/types.js\":\"caa2229c1262ee72\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"77201837ee7c18ce\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"eb57e0ff23a95d50\",\"/knowledge-medium/src/shortcuts/utils.js\":\"72ee3112a63cd0ac\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"45f82c566b60436e\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"4d9253dbe594d9df\",\"/knowledge-medium/src/sync/byteTransform.js\":\"bcbdf7f6a00d52d0\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"30a7651cd6174980\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"c738f083e31663e8\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"82fcc56b981ebc72\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"3a4b053dd34b66b7\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"e21f6b293a22d713\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"1543507c5d6a56d6\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"819967cc0a0d7b7c\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"abad98501e58b042\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"9c45578174ea5e54\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"4ef4fc98ed4249cc\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"47cb17d70a98a46a\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"86bb718de9acfa47\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"abeb86401a35eead\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"ea59871c08409db3\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"80d5319a36f3f7a3\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"dae9cee743760112\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d5c85e069f17775d\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"9b5d07f9473b371e\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b5d9dead75cdaecd\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"6317f1f2f350b925\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"b6d6879e76c374d6\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"b4c69c6928d5fcbb\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"7b3421e7cfd984ef\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"714896dd91563daa\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"a7457df0dfcf356f\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"554fc6de49c62aeb\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"577e5d7c356d4a6b\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"d67ffa1dd06b3eaf\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"92520ea067996e1b\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"15832b4cbbc45bd9\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"4748422798f2ed23\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"e08880979416dbc7\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"75e613fd3c6b8ab0\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"5b2283d14f5c20e1\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"b5e19fd7b63806ec\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"24a4f48eb742a15b\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"377b79e41944ecee\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"e6e0b0803ba8b802\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f5635e15ab47ac07\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8d24eb3a38cc4b46\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"05b831aa1bcee8ac\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"94312ba03686e385\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"8549791cdcf1a905\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"7f6b19ea995560c5\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"649e5a28dc50e7e6\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"0716208ba58af950\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"7848a7cd3aa4266c\",\"/knowledge-medium/src/sync/transform.js\":\"2d9b9aa175545aed\",\"/knowledge-medium/src/themeBootDefaults.js\":\"39d66191ae4624ff\",\"/knowledge-medium/src/types.js\":\"cdb3256ce1616527\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"0d17e98d03d235fa\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"9cab8999c14c4e81\",\"/knowledge-medium/src/utils/array.js\":\"12dce82eca2643ac\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"ef124de3f0a38e5a\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"c5904bc6e1620d5e\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"c219f91c9afe4c0f\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"602d1c61d94d2245\",\"/knowledge-medium/src/utils/callbackSet.js\":\"7b1aabba11016825\",\"/knowledge-medium/src/utils/clientId.js\":\"8d1bef87f3b23d09\",\"/knowledge-medium/src/utils/codemirror.js\":\"064c74d711c74c4f\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"91d8b4243a7a01e2\",\"/knowledge-medium/src/utils/copy.js\":\"8a2a5e60005b3f94\",\"/knowledge-medium/src/utils/dailyPage.js\":\"db281057e1290623\",\"/knowledge-medium/src/utils/dbForensics.js\":\"c1c6efa7f9c12ea2\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"80a3bc47d61320a4\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"ae8ca700adf581ac\",\"/knowledge-medium/src/utils/dialogs.js\":\"5adacd41650288a7\",\"/knowledge-medium/src/utils/dom.js\":\"b207572388eb81a4\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"ef46b7c8d0ae1972\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"d1a520d2a721d9ef\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"bd0debdb78f3e3fe\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"8a4344ede911d6c3\",\"/knowledge-medium/src/utils/flipSlide.js\":\"d2884d08c18ca1a0\",\"/knowledge-medium/src/utils/fnv1a.js\":\"9b7ef8a944bc4451\",\"/knowledge-medium/src/utils/formatBytes.js\":\"acc282c37f312407\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"ccda2e7761353c70\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"fd777b58cedeea9d\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"392452708155826d\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"dcd91a8a24cf739a\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"4d7eeba3ff1381a1\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"d3351269891275f2\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"b7c46443dd071ca7\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"2d88a181211ddb9c\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"a34edd1a37ec3bdc\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"f10dc799f776fbd5\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"ce118feb8cb467c3\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"7ac543bdcc938e53\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"a8a8dd3d7e3c7575\",\"/knowledge-medium/src/utils/markdownParser.js\":\"ff6a28e085b95331\",\"/knowledge-medium/src/utils/memoize.js\":\"266ef9944d9315c5\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"616e79c799d5ebcc\",\"/knowledge-medium/src/utils/nameList.js\":\"be50a101bcc11215\",\"/knowledge-medium/src/utils/navigation.js\":\"06e674d531f481b9\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"35e5f4e6d82649f4\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"178aa7395cf7173b\",\"/knowledge-medium/src/utils/panelClearance.js\":\"4dffa26bed6ac612\",\"/knowledge-medium/src/utils/panelHistory.js\":\"6870574338ee9517\",\"/knowledge-medium/src/utils/panelLanes.js\":\"c16e26f487671fb1\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"ad7c6c7d457dfe01\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"d9ca6d2302103286\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"cf7ecd7e856367ec\",\"/knowledge-medium/src/utils/platform.js\":\"21f92225d716b24e\",\"/knowledge-medium/src/utils/pluralize.js\":\"bd556080cfed356a\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"4ca57361e6a48e90\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"2e69648103c31968\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"dec27651a383c31b\",\"/knowledge-medium/src/utils/react.js\":\"48acc8bd2a4e4bf5\",\"/knowledge-medium/src/utils/relativeDate.js\":\"af322e5936a92843\",\"/knowledge-medium/src/utils/relativeTime.js\":\"7226d09dfd5d5b3f\",\"/knowledge-medium/src/utils/renderScope.js\":\"eec0d3c82db88bf5\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"2d2849b25120be59\",\"/knowledge-medium/src/utils/routing.js\":\"d1d765d862f6eef8\",\"/knowledge-medium/src/utils/safeMode.js\":\"418c69f64ca1c2ff\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"0bcb0d1f8a522cc5\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"5992efd3573c83aa\",\"/knowledge-medium/src/utils/selection.js\":\"004daa3ec4c27d6a\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"00ef6be596fb1921\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"95a786b07e974921\",\"/knowledge-medium/src/utils/state.js\":\"cb34cf3d3c380c29\",\"/knowledge-medium/src/utils/string.js\":\"f0a7568d7d1bb088\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"61df88dcf9703aff\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"55fdcfe7c2b975d2\",\"/knowledge-medium/src/utils/toast.js\":\"8ab993a9cc90ee66\",\"/knowledge-medium/src/utils/toggleStore.js\":\"3e2393050d98fd53\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"01be328746beec8f\",\"/knowledge-medium/src/utils/userActivity.js\":\"3875f8aeb4cc40d6\",\"/knowledge-medium/src/utils/viewTransition.js\":\"3ab4c9712fbcbf66\",\"/knowledge-medium/src/utils/viewport.js\":\"58fb5a907d00c404\",\"/knowledge-medium/src/utils/webLock.js\":\"af4fd1d8d6834ef3\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"80c3f2151a974a78\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"a1a22e572fdbb0e2\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"12a023fbc0fb41c0\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"790cf47ed5e9f476\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"b7bee302d39d7bef\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"e1789ce9e21ac55c\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"2ef7f2d23679ed1a\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"48e3c781a21a79ff\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"46bfd329325db998\",\"/knowledge-medium/src/vendor/react-dom.js\":\"e45b6b34a9b432f5\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"8de9edac170c831a\",\"/knowledge-medium/src/vendor/react.js\":\"5509c1acacd2685b\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
