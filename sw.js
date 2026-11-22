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
		buildId: "39a458d1e5ae-51019e4f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"80b83d94bab8d44a\",\"/knowledge-medium/index.html\":\"80b83d94bab8d44a\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BUz3uq3s.js\":\"95e3ed450b2ade93\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"e422e76745755a8b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DUKEfFP2.js\":\"13115415479dcd9d\",\"/knowledge-medium/chunks/FacadeVFS-BpeHGDk6.js\":\"35e321f5ba4ae754\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BmUSCf0K.js\":\"22367ae281a8289e\",\"/knowledge-medium/chunks/MemoryVFS-DQVqXibg.js\":\"814caaa66c69c683\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BA0BuuKq.js\":\"46a030aeae5d02b5\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-oOQZcaic.js\":\"2caf390c04a12a88\",\"/knowledge-medium/chunks/Preview-D0NXAObr.js\":\"2c046f81e2078800\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DEQZylyq.js\":\"899712c7bfab7279\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BTms6t_3.js\":\"62ea2586b6b6b01f\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B0W6hH7T.js\":\"3fd5ea66ccbf2abb\",\"/knowledge-medium/chunks/react-BDbryHQZ.js\":\"ce5cab55cb0a134d\",\"/knowledge-medium/chunks/react-BIzkDSJV.js\":\"fa55ec60411c9b79\",\"/knowledge-medium/chunks/react-Bdj15dHP.js\":\"49e9bc5c6896262a\",\"/knowledge-medium/chunks/react-CGH0xLDX.js\":\"74fd3f682f782437\",\"/knowledge-medium/chunks/react-DEspoSct.js\":\"95bc4097a93c70e7\",\"/knowledge-medium/chunks/react-DnnJ1uJP.js\":\"f74febd9c034c2e8\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BZevuiLv.js\":\"5a1346b36b006ffa\",\"/knowledge-medium/chunks/react-dom-server.browser.production-BW714sB1.js\":\"cdc8101d74fa18da\",\"/knowledge-medium/chunks/react-dom-server.edge.production-1cudmzzo.js\":\"d33f75f074a68df2\",\"/knowledge-medium/chunks/react-xrb4veBd.js\":\"236a4d48ff170591\",\"/knowledge-medium/chunks/server.browser-BCXrwvbr.js\":\"e8e9f985aab95062\",\"/knowledge-medium/chunks/textarea-DBC9T2RN.js\":\"c17a5450c4f024e5\",\"/knowledge-medium/chunks/ui-DW3e86r-.js\":\"d372fa98be3ff846\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"4aa8ceb5a81ee436\",\"/knowledge-medium/src/appUpdate.js\":\"26a6c8d7b404f36f\",\"/knowledge-medium/src/appVersion.js\":\"af4f5bc2c8cda7c8\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"313048c3b6db8a3e\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"aae01ff7c23a2f44\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"c134f896bbd1534c\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"555a92391f4406a9\",\"/knowledge-medium/src/components/BlockComponent.js\":\"722f52b8733007c8\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d88aafc0b8dfeb75\",\"/knowledge-medium/src/components/BlockEditor.js\":\"8cdc62f140630e67\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"ef3a5c2d83f24931\",\"/knowledge-medium/src/components/BlockProperties.js\":\"d4a6067f9c035a66\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"34dbcef5edbebefc\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"0ad310d47c98ec8f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"9c663f40fe6f00bf\",\"/knowledge-medium/src/components/DraftEditor.js\":\"856a7bf7434f844c\",\"/knowledge-medium/src/components/GutterPill.js\":\"33c6aee244e8981b\",\"/knowledge-medium/src/components/Header.js\":\"708411df364ece62\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"c91647035054a4d0\",\"/knowledge-medium/src/components/Login.js\":\"06744c5bea2df9a4\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"37c96688d57e4d1d\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"a53f95244c7deacd\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"59f930dab79f639b\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3961a23f1040f278\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"09691766fa19e623\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"8848af8a108df23a\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"6f22c9c0e416ad67\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"a819adc628d3b750\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"5ac14f4629702619\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"1298bc4a6dafcbdc\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"d77725518a0d9160\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"5015427125911445\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"fd6bda2b2f65daf3\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"17cd693396bd3582\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"d0133d0a5424a80d\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"a1537b538a00f839\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"587373b70aa79529\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"af0e4cd57757d9a2\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"5a4c270a7adb6d34\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"976fe66adda33bb4\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"4c7ccb90142fd99c\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"b8144206ad7b379c\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"93f4a196a0e5df19\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"f8d2d8f7f27fda4f\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"4fd3c5a34c4a4832\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"5023412b519cfc23\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"41dd40d3938eb2b9\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"c920f2cb367db49a\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"a2ed5832de1beef1\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"4b33cb007f9147f9\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"caaf6aeef1fd261a\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"f421e382bd615a19\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"3eda4726f6db0edd\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"ee3e672b9494c6de\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"050bc6e36ea1c489\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"fe2c71d79b0d51fd\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"31e790c7822dc0fb\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"95e41dceedfd9ab1\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"d72131190541186d\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f15e81a828958b0a\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"5bd09b28f00ffccb\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f2513a483368c3e0\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"c769e5c6da3afe84\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"422b53035fa3438e\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"3e58e9335eadc3c6\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"39a6ee87d75057fe\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"daa2fc68e2b0abea\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d658b2a80bcf95b7\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"6bf96ef3d366d479\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"6e2f5c3a594a3453\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"b402883dfe58b617\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"db713f9c6e49e99d\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"3d9c33c34383343c\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"a973e5b230756743\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"76670e17ee4e2d43\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"14cc4ebc7173ac56\",\"/knowledge-medium/src/components/ui/button.js\":\"2f2f75f4bac49399\",\"/knowledge-medium/src/components/ui/card.js\":\"daebbc2e911ef1d2\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"eecb7f6d3a3b5362\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"ef6d564ebf9c355c\",\"/knowledge-medium/src/components/ui/command.js\":\"6cca7da92ca57cc5\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"737f924806200442\",\"/knowledge-medium/src/components/ui/dialog.js\":\"0773252622a5475d\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"a2a535e778b39503\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"6741910e29128fd3\",\"/knowledge-medium/src/components/ui/index.js\":\"e54bdb2352e5385c\",\"/knowledge-medium/src/components/ui/input.js\":\"f26fe267a3939fdc\",\"/knowledge-medium/src/components/ui/kbd.js\":\"b00f21616ff4bff3\",\"/knowledge-medium/src/components/ui/label.js\":\"a419af75f47a3d1e\",\"/knowledge-medium/src/components/ui/textarea.js\":\"042e3416edd6de1e\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"e73807305e596014\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"191da0709c24b3b5\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"d8a3f8055c039cef\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"e6856330044279e4\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"c7e90d80b2de481a\",\"/knowledge-medium/src/components/util/error.js\":\"b5cb494b55c1d0e9\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"2be1adf81139ef78\",\"/knowledge-medium/src/components/util/suspense.js\":\"ff9155caecc9d591\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"c527481f242bb8e9\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"d74553b2babf6b43\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"c5e5f1e813bb6a64\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"b623a02552866328\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"716302d3eed48a9e\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"a1b8111ba62b9f79\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"d8742f18e1c4fc03\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"99596bcb48d5d3d3\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"b540bfc94d99bfb9\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"04ec9547701f7fd8\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"c11b88316817f96d\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"039017d988bbd268\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"40fb71d2e128cb5c\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"5289f26bd70739cd\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"97029611f7a26b5c\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"c2ec97c58f3e18a8\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"7c65cdabe7b74e07\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"4e47da615c8bbd6f\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"9b455d9b819b8b1c\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"e3e0a751eb101b17\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"0c2c78de7ac91f4f\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"99c1d8b7613b8d72\",\"/knowledge-medium/src/context/block.js\":\"659de190370d51c9\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"731fd1ee849578ca\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"7910df9a90120b1f\",\"/knowledge-medium/src/context/repo.js\":\"2d5894ac164ab7b6\",\"/knowledge-medium/src/data/aliasClaim.js\":\"e56e56d025edfc87\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"66b5093d816545ec\",\"/knowledge-medium/src/data/api/blockData.js\":\"47baf1a355f66f2d\",\"/knowledge-medium/src/data/api/blockType.js\":\"646806a8f3392d4e\",\"/knowledge-medium/src/data/api/changeScope.js\":\"ac6d433f815fcde2\",\"/knowledge-medium/src/data/api/codecs.js\":\"886dca24377a3ffa\",\"/knowledge-medium/src/data/api/derivedData.js\":\"96b15202081f4ad5\",\"/knowledge-medium/src/data/api/errors.js\":\"545a4e49b5ff199d\",\"/knowledge-medium/src/data/api/events.js\":\"555c5f5f0409bd70\",\"/knowledge-medium/src/data/api/handle.js\":\"f47c368217426d44\",\"/knowledge-medium/src/data/api/index.js\":\"e06bd7933840d26e\",\"/knowledge-medium/src/data/api/mutator.js\":\"d561674ce6699487\",\"/knowledge-medium/src/data/api/processor.js\":\"de80460a9fe5890f\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"f96c4953c73214e4\",\"/knowledge-medium/src/data/api/query.js\":\"d7b10a033ed63b7d\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"7a90476520bc551e\",\"/knowledge-medium/src/data/api/schema.js\":\"f47c368217426d44\",\"/knowledge-medium/src/data/api/tx.js\":\"f47c368217426d44\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"a8193a59859eed66\",\"/knowledge-medium/src/data/api/user.js\":\"994a59b96bfe92f8\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"8af389d1de5ac59c\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"4fcc9b0938e13234\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"8d51e766b7f5394a\",\"/knowledge-medium/src/data/block.js\":\"78267314d7da5cb3\",\"/knowledge-medium/src/data/blockCache.js\":\"572d748d930a34b2\",\"/knowledge-medium/src/data/blockId.js\":\"13a7fa38d7aeb85c\",\"/knowledge-medium/src/data/blockLiveness.js\":\"499ee3792cb69b18\",\"/knowledge-medium/src/data/blockMerge.js\":\"8d9d38f609e47b1d\",\"/knowledge-medium/src/data/blockSchema.js\":\"43391b268dc1c0d7\",\"/knowledge-medium/src/data/blockTypes.js\":\"3c63a8c2a4bb706e\",\"/knowledge-medium/src/data/clientContext.js\":\"f017731469b79069\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"3ce75d1335c13100\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"7057f234ff4442b0\",\"/knowledge-medium/src/data/derivedIds.js\":\"8d475a3a5e6762e0\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"5a93fb05065f1a6e\",\"/knowledge-medium/src/data/facetBridge.js\":\"39d8d2ce095163ba\",\"/knowledge-medium/src/data/facets.js\":\"c328463ab8c9ab97\",\"/knowledge-medium/src/data/globalState.js\":\"e74abba598f6c1f1\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"94a191947053ebf8\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"683a62bdda643ace\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"48fd259ab55d7893\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"5ab16257d4f0f57e\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"d68ba942a763dc6f\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"da1499aa8440e740\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"82a22528d6896cf2\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"5e62e6d207b23811\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"dd2434d88a25db50\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"f71d04b3930a05d6\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"423b9b62bc89ea56\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"0a8e67d473ece3de\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"7eb8e52e2a50bed4\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"cbd52f33f8fd6d70\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"8e63c2b181e14ca7\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"f365fa4380858553\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"58d4051dd741bcbd\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"ab1be611c1338817\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"41326822b7e30bdc\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"39a78c9a680f5f08\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"a5cd4645416e9dfc\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"0c61f76e220f1948\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"e6482336036280b8\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"30817a0084d20a99\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d4ca6c1663278021\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"51649a76a47a3aec\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"f0923ebdc6338c00\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"052bf1f341b0760e\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"d373246cba64b4df\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"c26ae4fc509052de\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"fcf63144ed826dd7\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"8642c974bae9f8cf\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"b5d5b99e45c1ad40\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"e6cebe5a5e0b6dcd\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"386f36b09e18d8f4\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"393fa8bf3282ad84\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cac71ea3e8074e72\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"1330c41dab8f274f\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"5e21730bbcc8e4fe\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"3d3b20dcf1642cf5\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"8fe2c38c5812dab4\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"d8632082bcd014c2\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"772fe7b64a44d778\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"4a6cb90e00e3f5cb\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"222ef1812bf5502e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"acff59eefb42ea0e\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"b79ef495f396e6b8\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"84aad24dd9e3c545\",\"/knowledge-medium/src/data/invalidation.js\":\"98a5ad3f2b58e5da\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"eed6130c9ad58281\",\"/knowledge-medium/src/data/kernelPage.js\":\"fdd7f9165df38648\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"cfa200e622d271ff\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"47ae7f8b7b3745af\",\"/knowledge-medium/src/data/localDbStorage.js\":\"696ec73fbb46c47e\",\"/knowledge-medium/src/data/localDbVfs.js\":\"43293210006f8677\",\"/knowledge-medium/src/data/localSchema.js\":\"8cc806264e8ecfab\",\"/knowledge-medium/src/data/maintenance.js\":\"109faa1489fe44ae\",\"/knowledge-medium/src/data/mergeProperties.js\":\"73522581f15d1192\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"a0bab2086574278b\",\"/knowledge-medium/src/data/migrationsPage.js\":\"8121a02a35a2a627\",\"/knowledge-medium/src/data/mutators.js\":\"4a17a4ef0c33ae6c\",\"/knowledge-medium/src/data/orderKey.js\":\"3e50d6b86b628beb\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"7ae1af741ea38c0b\",\"/knowledge-medium/src/data/outlineSurface.js\":\"0e320d24c7ea7209\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"b56550f089a05a04\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"99f4101c22b3673f\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"b9b94d8ba4b2d66d\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"d6120f46e17fc142\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"008db764a15077d5\",\"/knowledge-medium/src/data/properties.js\":\"0b911675bebc9e51\",\"/knowledge-medium/src/data/propertiesPage.js\":\"9568d718a8724a10\",\"/knowledge-medium/src/data/propertyChildren.js\":\"ba769e69fcfa947a\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"1336170f0cdfaa11\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"112d8f6497ba9e3a\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"0e1ec81a1adb2f99\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"54389e1972934a69\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"3377762de8f055aa\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"56abd9d68495d789\",\"/knowledge-medium/src/data/propertySeeds.js\":\"9878262d374119b2\",\"/knowledge-medium/src/data/recentsPage.js\":\"da4a93f4f774d133\",\"/knowledge-medium/src/data/referenceBlock.js\":\"c04b51a535cc92b5\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"559a2deb89d53b0e\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"7b7eb867e32f3c7b\",\"/knowledge-medium/src/data/repo.js\":\"6ab8171097cabc02\",\"/knowledge-medium/src/data/repoProvider.js\":\"82ebf755577d04d6\",\"/knowledge-medium/src/data/rowProperty.js\":\"652a0a1691b73f13\",\"/knowledge-medium/src/data/searchFilter.js\":\"e7bff6ab25beb69b\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"e9604672124990ed\",\"/knowledge-medium/src/data/stateBlocks.js\":\"555504c14a64405f\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"030c3e779600f5a8\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"85c5eaf9b0a9f012\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"7a6e2ed7f38f30f7\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"aea40fdb28c891c7\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"3410129f4a865be9\",\"/knowledge-medium/src/data/targets.js\":\"ed05bcaf862e8d11\",\"/knowledge-medium/src/data/typeColors.js\":\"d1f18c6bb5113351\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"a161a9a75fce8f3a\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"3b1c62a210373e0a\",\"/knowledge-medium/src/data/typeExtraction.js\":\"b1f1efaf332dd2c2\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"bb7bbd6d2b368b51\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"23efc36c69e10de2\",\"/knowledge-medium/src/data/typeSeeds.js\":\"6610726ed5c1485b\",\"/knowledge-medium/src/data/typeTagger.js\":\"be416960d75d2b97\",\"/knowledge-medium/src/data/typedRecords.js\":\"e976dd994b1d4304\",\"/knowledge-medium/src/data/typesPage.js\":\"88188c09d4fc19d9\",\"/knowledge-medium/src/data/userPrefs.js\":\"8e7fdf6efa8f8da0\",\"/knowledge-medium/src/data/userSchemasService.js\":\"eaf760b6412d17bc\",\"/knowledge-medium/src/data/userTypesService.js\":\"9da36f57c9c2af83\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"977828d1b544ed42\",\"/knowledge-medium/src/data/visibleChildren.js\":\"8e9697176085ff45\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"910c67fe737947a1\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"f444e549e0884bb3\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"b67adb232122b357\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"631a2923bbcf60dd\",\"/knowledge-medium/src/data/workspaces.js\":\"cc133a097cea3696\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"30912775743dfe28\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"b33f7ae0cbbe6f8c\",\"/knowledge-medium/src/editor/atTrigger.js\":\"586552ae20ff3653\",\"/knowledge-medium/src/editor/autocomplete.js\":\"2af6d81930164811\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"57d82e3485c85f64\",\"/knowledge-medium/src/editor/contentFlush.js\":\"e461804aba0394af\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"baab1ec514bf1b12\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"2ae49da4e75a082d\",\"/knowledge-medium/src/editor/insertImage.js\":\"25a1fbbf68d4697f\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"358968e52e28fe8d\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"84b06a80a635c2ea\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"ea97f66e5a426a02\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"3e252b01076ae2cb\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"8f2ba062189d332c\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"3b7205ca2a0fc469\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"a2148b2c66c27675\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"996b0efcac64b449\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"04068e27a95cc98b\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"23ae8a9bba85413f\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"bc87ec6e40e569de\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"ea08fd726aa2e49f\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"c401bf220c4d89ff\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"15b02e648560377f\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"3d5634440138aeab\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"dda83092e4313bf7\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"78bca5c4159542c7\",\"/knowledge-medium/src/extensions/core.js\":\"0f20dba3697dbcc3\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"a1541194ea943b7d\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"ec9349f2e9b7f516\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"5e467797b812f0df\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"c3171c6ef5b68f26\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"b28256fac0bcdaaa\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"55c65d67a323e70f\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"e3dc2af4485c92ee\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"a2c6c568ce888b39\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"e7a2af50f6c50e44\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"50d8e1dbf6ed57a8\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"935ede603ab94823\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"5699e5be48dddcf7\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"b9a59ec503db7fcf\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"bc4d8a322f83b226\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"4d6ed86db8ad8a7b\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"8a58dc19e3b244a3\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"3d6e032e56216181\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"76282ebc8dc680b6\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"08446276ae78a1b5\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"47f680ca3c0b7506\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"35173d4b0017eb2b\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"a827b2d3df930a03\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"321d4232995d560a\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"959b3a145f233b1d\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"aaba2ed279f82901\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"4d2fa5b23e93ddc8\",\"/knowledge-medium/src/facets/facet.js\":\"44d25631bce75a38\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"af2a8987393df108\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"26833f211926b763\",\"/knowledge-medium/src/facets/togglable.js\":\"c0b0d86da0a45585\",\"/knowledge-medium/src/facets/variantFacet.js\":\"12edf9ce0ef89736\",\"/knowledge-medium/src/facets/verbFacet.js\":\"4257d7baa5e3a703\",\"/knowledge-medium/src/hooks/block.js\":\"834b99526144f8f2\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"78e426f467e7b84b\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"0faed47fbecbb3d1\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"989b06eba9a6ba66\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"cc03b28c8d2aa100\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"4bda8c37aca51aa5\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"f5c28129196ccb3e\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"828817ab345b6196\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"6adce69afa62223d\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"e290f0edf054f74c\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"4cd28118e657d692\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"5edfab0dd53e1128\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"fbde405b2cfad98c\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"9b89940c534d263b\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"3e313b92fd82f5a8\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"b250ad765611a570\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"162bf5c5265b4484\",\"/knowledge-medium/src/lib/utils.js\":\"e4617ac77729283b\",\"/knowledge-medium/src/main.js\":\"00c21a605568c6b1\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"55c915bea493fcf4\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"9581bf6cf2346807\",\"/knowledge-medium/src/markdown/context.js\":\"22be4e906ab1b9f9\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"ba9fbcdabcadfbe6\",\"/knowledge-medium/src/markdown/extensions.js\":\"761ee437bf1d98ba\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"fa27b32c9f3d6cd4\",\"/knowledge-medium/src/minimal-editor.js\":\"4118be4851b508d3\",\"/knowledge-medium/src/paste/armedCut.js\":\"5f81007c878f2119\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"e2f93f8db670cab3\",\"/knowledge-medium/src/paste/clipboard.js\":\"87b5adff665c08d9\",\"/knowledge-medium/src/paste/decision.js\":\"f2597b1fae7b44ee\",\"/knowledge-medium/src/paste/operations.js\":\"3b538bef8f460666\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"8e01254b8f4d025d\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"860107fbe3707cc3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"3fc16e80f3bb7dbb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"812b2ee7b9125cce\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"c931eb4623d419d2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"363f7a6ab30838a1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"9b20c066bf5f2e16\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"146e6d3ee25ed961\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"ac37c9e94da17b62\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"605fb42b6c63e0df\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"6fcae55ee68a079a\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"4af5b7e9eda9f7ad\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"09717a5f630ff4f2\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"d6ca63c1bc9e9607\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"54d220d23d7629d9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"342719121201a415\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"dc232c031579e695\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c7768936e04f4b3f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"5a2ab41213141f4d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"7f87c20ae6100c7b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"f31d720233386ccb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"ef7e594dbac05166\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6af997d10b2937e1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"c7caab4f44c8e894\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"74c22b39397eb105\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"18cf7263194d6592\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"c74e1ae7e7450765\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"2e5bf791870e9020\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"4398da36a9bed8f5\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"2ffa5f201fc998b2\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"e97a515e0ae954ed\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"90f55f74c1d61071\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"b67ddb5aebe35742\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"140e6572bb746d9c\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"74aa4fa1c1eb3ea7\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"bc2fe6a91d64782d\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"60bf13e6ef4a1771\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"ea65763c71025651\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"c3a5125cd439bb20\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"f0baa2c425d4efda\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"3685b398949adae0\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"941925c487224ee8\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"507ca7989c2fdd2c\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d8972cd5122d0992\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"d46cb0be18ab99a3\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"20c8e8a4e1d1efff\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"2bef49a1f291c4c9\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"871a9ffc2d91e0d7\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"5553adddb3944119\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"a9b7150ff7fc2a8a\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"f215d3ec71b7690b\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"c3f6fdef480450e7\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"3d0e1078bbcd6db8\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"2a0f1b36fc2cfd6e\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"3c2005ebb941a426\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"e0014b737541f20d\",\"/knowledge-medium/src/plugins/alias/index.js\":\"1baa784edb2bcd44\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"d23a44e060eaacb5\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"dcb40e95ac2adcab\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"af9934da6d96f11a\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"90caedbc15e17771\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"f1fd12b441d77ae3\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"2a655c3786571e13\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"9ffbb1106d248dda\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"1b80c01a3dbae5d3\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"32dd9f8e7e3eb842\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"4d48b4221b3e9381\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"55b78518a0c9ba2b\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"05798caa23deaefd\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"1492259ca9718499\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"7a259bc4d10ed51a\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"1731513e4adf0f99\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"16357576ba235535\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"023589cea75b298a\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a69b8e2bdb8c726e\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"15465ca01ee376b9\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"093a1b9903ce5de6\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"87255bf4bd0cda96\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"9ba7065638d969bd\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"440965c783ffd443\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"8b0f5abafd58e178\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"eadff0b63496f5e4\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"3f675075533292ef\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"f2c95bf6bce65443\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"554b6a7269ac3f9d\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"407fbd72b9c7e946\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"bbf543a3b9330adc\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"91d69cd6b36d1597\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"13af468ff149e7d7\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"4af44de8e7c9773d\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"8b500ba9e6dd42a0\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"a957ad7b607120bd\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"018a8e70405a71cd\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"a9b0caf5161910a1\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"b8d5e7764c954b5c\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"eb96c42167efec89\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"fe0283d35856c715\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"1c1898f2b0d9a033\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"9b292c52ff14aae4\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"d8d1ad5b96cc78d0\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"1138bf3047100aba\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"6782b1aeed08578d\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"bc0ba436510899a1\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"b8c5cc6a3730e47d\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7a5f1e9d8a38b82d\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"d83910bb2eceeee5\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c8e8009bf0c44840\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"b6bb65ea81feebe9\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"eea58d27425dbfe8\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"f6fff80c3c543448\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"7773cbe462c98af4\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"905fe70cc14969fe\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"42d5e580bcd616fe\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"ce6fa2c39e842bd6\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"2158615b7a5d064d\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"7b6a37e31031a0cf\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"6ce9f10a993a3e98\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"977fc838ab543684\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"5fde7d3a23e8dee6\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"3dd57c420307a724\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"0c973088ff083ab8\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"b4ccbee48de06cce\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"c1c35de4fafb3af9\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"4bd5244acebd96a1\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"db0b8b412ccd047c\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"235e306c1ccfdf9d\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"0f4591cfb61d2ccf\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"17c94750598070c5\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"6401b560feeac031\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"94a7918942dab6ca\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"2dd3d5f573c65811\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"320187ca68adfb52\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"28d33b2b0f8fe539\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"a24cc9970cacb6c2\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"2c6edb00792ef5a5\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"14f2e5bec634c79d\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"2aa7e72f1f23261c\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c6f13cb17a7e13b0\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c3d60da57209cc0c\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"378dc2e858111a1d\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"369835eac900eea3\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"c5f059db94ed0797\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"7e65bbe52581acb7\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d663a3c95be5f914\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"3d26ea99d4db7248\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"a6094cc5ecd9bf73\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f243b0925d47d6ee\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"9ed0469958e91e61\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"9d9c1d56770d48bb\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"efbbe39a9716260a\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"d5e0164c8bb0d810\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"887f5d16dc697d63\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b7da5fbbb10edbee\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"6c26bf48b0fb27fb\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"436c9efb7853552c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"504d0dd07a79b7a1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"3429c0ac591534b8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"45a5d78988c67653\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"12534edc02662d52\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"94a8083c5e350b50\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"9747efed1f813c23\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"9d6ab21c07dcc35e\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"c5fcd2b378c963ff\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"1a9b5f9e0d03dc4e\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"976562fb0c27642e\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"c8921e1897583026\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"346488d2ec25a519\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"dadd083915a90b14\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"4e5c771c98f6bffe\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"ed3d9fcbce94f2d5\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"e95b4a7fe30b8c39\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"2ff902effd591641\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"4c06530422a4dbab\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"a27b89133ff26673\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"00463236e65de24e\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"ebeca8f4136985d9\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"3a70bf36f354c72f\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"b2f41828df1ede09\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"1cac87ff01963a42\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"c35303de0ca1e8a9\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a38e09240f932a7f\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"0152ea9d858ad3dc\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"4e06b331ac7ac174\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"8171d0cb524dea94\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"7771fc15faaa94eb\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"e0c4a3b736356674\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"4c070a83fd31e872\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"1fa9cc41938f5234\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f83c052477629ef2\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f295d5ca852d884a\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f120df4252900327\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1be4780faae3076b\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"11f593d1e2009ad2\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"c2948b1f46c79a18\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e4e3b2ace63814f6\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"0c0093d31786819f\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"fce36a5607f8a41a\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"45a2f319f4c50c70\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"d35cb5e2dbd28807\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"9a66bff815dd15a7\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"406f9a945481f597\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"43fd2b9305c267c3\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"2905b4e8d9d6ac82\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"637a74b90a35de8a\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"aca372fb0efae966\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"70f2982e61a3700c\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"cbca55be372bb240\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"9014a0007fa43874\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"fd31c4aad34e3edc\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"1a65376b26db809f\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"9ec77bce0a3dfbc2\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"784452db44542391\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"03dcff568da5c5cd\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"a0910cc121f1580d\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"f933b8d6c6e61c7a\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"f25319576bf9b3bb\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"f1a97ded69caf2a0\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"b88dfe67af4fff21\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"02578f3a437b504f\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"1ff0c94b271b4018\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"0f43326f96b5a841\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"5d1b725d51f59725\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"a115f2b3e799423f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3d75124e94697d90\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a10dd37809ecd5c8\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"3f407c90d6d25339\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e1b2fee31579d08d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"98cb9fa8ed4a857f\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"b003cf911aa13c34\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"a2d84792d31b2219\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c1aecb1465e72e3b\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"387d0dac0ffe75fa\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"163b08d40f09342e\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"64209b9b10bcb834\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"9d04122e0e87ea1c\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f6b34ec91a414139\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"1f0b061d2d3f9cf5\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"f8345b5fcb0a415d\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"cf74ce0df2298ef6\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"135171cf76d39d77\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"ee65dfa51bb84760\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"94c6c85f2ad52edb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"56c1497dd1d6a175\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"42ca60f3f967859d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"762abcd80ed041ec\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"9097c03b68a92259\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"e5dfc89a4d73a7be\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"d4590c9b981d1089\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"f246335ff82a5b6d\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"c3e43c3f3b991584\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"6e1c910a14a999a6\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"f9fc53c6a31618ef\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"8db9baf7de32eed6\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"2cd796fd9482b317\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"7bab08c97c0e3b80\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"c3e5d41920baacf8\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"6d5bce7bc802a9b7\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"71599c04076af4c3\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"899cdd3520f5ec54\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"b5c3c910e7cb8b19\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"f69fa20987aff911\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"9411e62428fe183d\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"90ebc621c6b0865a\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"ffb99a9f208e1624\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6b713fe6ada0eace\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"4151fd73922e5526\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"a3100547222df9b4\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"424842f5bf050d76\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"5e0ffafe5e3ddd5c\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"fae94e36b5cfc555\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"64d0a0a13430fb7e\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"de2ecabd4524b736\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"08183dbb912ecd0c\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"aa9b956fef675842\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"db900435f41a0d04\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"dead82e8756bf274\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"48ddab18de33b128\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"ea39566156c6d707\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"f4a555c60fb401c6\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"574c2095f6942ef1\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"247773cb4356f669\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"9e0f815c124bfe5f\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"8c1c826117ab1fac\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"5fe14497071cf213\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"9aa08d9c62db8c26\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"2ad88dc95f7ab638\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"f704dff089e74189\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"bd54005c735f917d\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"45ccfc1a60a20612\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"cd628e114152418f\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"2f6fbb9e7fc67691\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"1721a24095f36714\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c1317f04a49f3711\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"42b8d08131de818f\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"ee91aac9d6068343\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"033000e6a32644e0\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"c928982886b75b23\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"831375f46221456d\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"40dd5d7032d90038\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"88415b572dcbb77b\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"536cad9c4d283bd5\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"74373193e37badf3\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"bce341079b155ca8\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"04e3309b58b8903e\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"377fb200b72e5142\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"09e14f79c115740b\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"936d10eccbb97208\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"5c9254e72e4eea78\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"0a0df1d201be45ec\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"205ba83882539c57\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"e2dcc331a26de909\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"9437d754f52ac3f5\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"4c0e409c600b146e\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"57054d23822e0377\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"012e864509ff733d\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"b7d573a9e14fa56d\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"34bdaac065c856ab\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"1c22046751e9381c\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"13efb97a06364089\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"40b41e06bf21f177\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"822b2c0e719eec2b\",\"/knowledge-medium/src/plugins/geo/index.js\":\"37b7989056a1c56a\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"351ec2dead7e9532\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"e9d750ee45351a09\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"9affad7009410f67\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"b039de9b17214190\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"63a3ff93890ed666\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"500a13e27d333371\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"7eefffacdff1eee9\",\"/knowledge-medium/src/plugins/geo/query.js\":\"47040ed8772e8b67\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"1528281e4ccc42e2\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c23ecab677695b2b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9ce2a6fc4d973e88\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e742b82fa2a7e09b\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"ab0fddbf2d0f6a61\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"23b330427b69d008\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"9b7e72a8141fd523\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"7d652e22706c823c\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"5bf1ec55954abd53\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"442ffa13eaf82b1a\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"719c5bfe0a1429bc\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"c22899dbe8d61107\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"db0d5ee9eeeb48f8\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d07467703455cc07\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"15b31b02b38ca913\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"f8d6a75264018429\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"1dc2a99ca03e7957\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"8f84075a11b41fd7\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"e14ba9615596ecee\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"f12aedbfe9a284ee\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"c04bcdb1782d29bd\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"0d6d25f54e364994\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"5c999bdf237bdf7d\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"42f94bd9eae5cfaf\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"9b57e955c82855c1\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"32266bb9af93176b\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"89ca7e222625c5fc\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"1e4369184bf8e87e\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"3a5a3d8615ae7bfe\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"cc19d97e544e0726\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"2e89f5848f132963\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"b413a0882cae55a8\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"02e6bbc1a97ff3cc\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d2ff3951e4392b50\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b50bafcfd445b6dc\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"424f3dd3df43439a\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"f38425a6591eddca\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"a8a426727df42cc2\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"2e9ad771934f6c95\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"7955d99683544a14\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"9a27f33a2329505d\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"a84a07ba95d11dec\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a0ebb696eed90004\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"85af87e17d299bc6\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"73497aa5d93177fa\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"336d137680098b96\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"e55d0cfe5fe05cbe\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"13e81489791daf1c\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"b35cfaf82c6690bc\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"4a4d1423dc6ca763\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"c035cb49efa64eda\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"52109d3fcf717f07\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"bc2fde08a6e7dba1\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"5583ec4e780f1ad4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"3c2993d18ba2d473\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e5c183cffe18e7d1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e4c0ba41d7fabd8c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"9ec0397e73b5f7f0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"99ee26c58b6b658f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0793a65a821d1ab0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7444e8bc23bca1de\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"530a424406c2da66\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"33fcde2c4bb2e9e7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"da34dae54893c654\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e319b2d5c3e403f6\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"114ae60191e03918\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"9d4a729b1eb9af32\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"a3dd65ad28955c64\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"4d9aee1f7b50e02b\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"f2942d0adf078d1e\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"272e73b90dc1ff80\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"fbbd4f9485b0904a\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"b031eafdce0b6baf\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"2df8c9791d636a22\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"edd51419ac253765\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"cacc86c24318aaef\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"97f00fc004f39e94\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"6a76eceff4a4633a\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"24816063545b06fa\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"d86ac4e0e5af7a7e\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c2ea91c66b6b148f\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"c98b43de4fae53db\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"968615c0902b33bd\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"5051b3422fbb23ba\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"8c1af1a43419a261\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"d266bbeced20d546\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"4852cf42a6e6a7b3\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"d42f53b17b667035\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"6834a91972f978bd\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"2dc3d17befa82e10\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"2de39ba246f2062a\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"ee6469c615690ebe\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"44fe79f531248acc\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"99ad163651cda127\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7d4506b50f0a033d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"77f8330dc6484014\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"ea457a7d2c2feec0\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"f11a2e22ea8dd3ae\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"7adfe0209546118f\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"5f99c678b49cf212\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"3119cbcf34d44d53\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"0f91d3333326a923\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"145dc84f78f83de7\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"6d075a457a17046a\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"a04d1918dcd3d915\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"ab8aef73006588d6\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"58dd924c71bfeee9\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"97a3ae8469ca731c\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"b937c6eb22500e8a\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"6c85a1f2d8620a4f\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"58a57824793740f0\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"3b89da9a4911dc19\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"8140989c81e73657\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"2f1f26c3504f2af1\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"57502fc70ccb366f\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"bc3f336ca7ee8642\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"d19daf903dd1b5f5\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"672cd48838ef4306\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"7d353055bb38d8b4\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"a26b533548749686\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"da9b746cf4169bfe\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"6ee64fbe13a148f3\",\"/knowledge-medium/src/plugins/recents/index.js\":\"2c23d113fb991871\",\"/knowledge-medium/src/plugins/recents/target.js\":\"6f3592837e8829f4\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"6a893e18e863cb27\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"886b6e5bdb1e73e6\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"52276cc47082484d\",\"/knowledge-medium/src/plugins/references/index.js\":\"e5efd73bb5eb0e41\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d8b5fbd9c080f31c\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"ce049cc98d017a14\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"ca082704aa8ce10f\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"7c83d18bf0554b8c\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"802ce84f393a0a46\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"e13172b5b1025e56\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"a00ff3c2ae33f9ad\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"033fc0ffa959e599\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f200cfad908190e0\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"875a012c806398da\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fd431d231785b7ce\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"52cf96d41ba33455\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"6ddd2031ba067065\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"e1cb7559cf436da0\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"b898c9ae96a40322\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"7c7486cbfbac5de3\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"2fb021704fe41656\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"5befb2acf7e86420\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"7cb207e41ba96021\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"4755b04caf3deb1f\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"94d2a4742cd62ee9\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e9202a106b4e3011\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"3f579f33e99aa114\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"8046612e0259c4fa\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"223ca2efb2ee20af\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"f5e7a3db5df49e54\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"e581687295868a8a\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"022009f7401d3acb\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"9343d79fb9bc0b72\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"faac72188c1f7abc\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"96aacb95d913c125\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"d0df213799aec289\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"149fe5b8232021b5\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"53ace9c7cdaeaefe\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"eb85313d99ac4ebf\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"47018d65ae6c57e9\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"505956fbd5e14681\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"4df4540b02289c50\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"f936a0a414a48633\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"c1fb5a0833397609\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"7af410ae4f3d1b81\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ea647bed5821cc65\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"d15b39514b86f957\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"b4f30895831cefbb\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"949de9f9e8eca94a\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"7bea51e4eff7530b\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3d759c05d087f029\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"272944425d6dff18\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"b9f5803a01a7568f\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"e6522b8cc3601179\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"95efbba504adafc4\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"2f38abc9d580dbb8\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"ee4bd8a9680834e3\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"4c1bf5c918cd41ad\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e23726cbd3fb657d\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"84e7309ac8d48d78\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"b9de568796e93a61\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"ca6408b0cc8030bd\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"f90252491ddd9042\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f844946cadeabd1b\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"fcbb069b592bdef2\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"50a62f0f35798676\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"4daaf7068ba5093d\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"499fad9796b8c5db\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bb71b5e12482b3ea\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"7485283352a7001f\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"f7710f7d37c1c645\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9c07fd43200b184c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"b4df3ece245b3602\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2be684cdc71a2d6d\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0a059d24d774e5f0\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"a53dc63a27d8126d\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"1a4d873829ae5c27\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"bcc2e39ebfc429cd\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"ac2a404bd1aeb761\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"3e7b6f961142df7d\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"7fa7d43326a6c317\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"b9d824587af2f07f\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"c635476681bc0eac\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"cc4687961dc2f6ac\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"7dec0ee4fcf993c8\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"ac2d3381944a4d71\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"e534693cb876a537\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"2ce16886a618c479\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"4649969dfe5ba0f9\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"f0a3a8fc0b4415c0\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"32fdb598341a440e\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"75cba793f7443824\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"6834780bf8a86d0e\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"073ab28b64717f74\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"d213bebc86d160a3\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"a1bf97355a5108e1\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"120eb10da5c59156\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"af3c7b33d0285b02\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"ce00e52f5554a527\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"e0e63339bd3914da\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8faa6df1ec555b0b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"b6ac0641a59b1be5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"79c9fe6c5d6f8093\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"1c1f81cfdd78cdc6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"84331f217f89365c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"c7ef5dcc24f3c616\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"13d49b01d95848e4\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"02d0196a0024700a\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"ea8691a0a45868d3\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"141fc9e22a226112\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"44c1af5b89e0d43b\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1910eceb4005d37c\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"a105938a8496764b\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"9a0a992def7e7f1d\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"bc1a7a807f74842d\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"330525a991c72066\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"ef7b173f57c6f2c0\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"e53d49a5e82a98fe\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"a2ceedd22d1cd35e\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"3ca27ce07c3a02f7\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"29648a6fe4d14e5d\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8e7ec39472f5be2f\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"7a40101fc5fe7d37\",\"/knowledge-medium/src/plugins/todo/index.js\":\"d2145f96409a420b\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"6dcfe3f716e22088\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d51ae006abb280ff\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"267284c617e67615\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"2afda29eb87655a4\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"0ca56e682e9c4231\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"b837a41eba055caf\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"2f35f3b18b3c38d3\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"2410c9cd4eb4cc92\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"744dbe78900e9278\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"c1d7acfcc8aa50c1\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"c8a32151f12213b3\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a10010dbed9f4676\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"71b1152628f7a94f\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"9a4680c3435ba7e1\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"8ea5f49bab286511\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"abf50d2bccaed094\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"9686bb285177ce30\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"9c2e12fc385309b3\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"b8357e2108c2837f\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"3082d7d7b8328934\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"f20335e12ab61b2c\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"ec34dc0225c3b9fe\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"04d848032615a347\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"83f293af0e736583\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"353c39ad77633384\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"cab4db1f9e97bb7d\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"a91c3790dff30399\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"0211acc8c7e7fe9c\",\"/knowledge-medium/src/registerServiceWorker.js\":\"67ed275510cecfab\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"d66b370936aa7d88\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"6533064793848b21\",\"/knowledge-medium/src/services/authStorage.js\":\"38a8c879c33b756a\",\"/knowledge-medium/src/services/powersync.js\":\"a9da67d93e16fd2c\",\"/knowledge-medium/src/services/supabase.js\":\"70874418f94908b3\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"bbf109df9d44ac84\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"762a3a6cbb55125f\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"f67421b4658a9d0e\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"dd35c1e27939abb3\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"5fa428e303761643\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"87ee816f65bc0ba3\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"ec66987b46c8ab2a\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"2499f5ddb4b6ba41\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"8039ade751a3fe7c\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"805bb2228de9cb3b\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"068b3962dbb615fc\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"0b27c22db49fec39\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"e0189703e64fc249\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"a0b719337f6b6c54\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"fb137b7e80f85235\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"7f5ce3393a70afee\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"afbd89b405c61160\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"49958d35f64933cb\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"9da8bd7e5a6a591a\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"82f0bec10f4f7b68\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"5870801f664049c3\",\"/knowledge-medium/src/shortcuts/types.js\":\"beefd234099981b2\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"65d0ac19ad875198\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"345d03d915aaef2a\",\"/knowledge-medium/src/shortcuts/utils.js\":\"6ccbef8d5d67e5f2\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"7d132e9dad712a47\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"8858d9bfa543e327\",\"/knowledge-medium/src/sync/byteTransform.js\":\"45abce855d8115b0\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"ec07feba2c88e2f7\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"36446aeff7459caf\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"f5a4f41a270578a3\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"5e03b0fb01b2e53e\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"bc0b5524b64f5e9b\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8144b9480da8f4ad\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"1b61adc6f889d0e2\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"dfa4d7fecd5f95ff\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"f00528641e6a7cfd\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"868f233737e13fe7\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"1a5df1738f51c50a\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"a7b17fa38aa302ca\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"c3f7ba0c2683f720\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"e5cdcf568c3d2567\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"d8fd17869e946348\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"07e2b59dd0aefe80\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"eea4f0fc55b3a896\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"c2905bcbda79aeca\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"69b362688d19061f\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"b263f3a775ff6dc3\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"37e7bdc8448169e3\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"27d1069e00b0112a\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"63040f6b98d1ec83\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"8d417d146b24e420\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"3ef8b5e3fe43eccd\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"875e9c3728b45ed3\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"7859b2816ddbaec2\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"83c99b636b162cc7\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"d8c1481c0a0c5b8f\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"f839d9e2996791a5\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"38e06407569a78a0\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"2bd4aabcb9ecee1b\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"e106552c1be764ee\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"68260c32b05dc668\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"b4f26ca9b8d36275\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"e694c4f58141426d\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c1008ace06ef1eac\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"5cd1a91baa60f898\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"93777060a35ab3a7\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f92580a0c47014be\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"ec41077fb9cb0055\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"c61c8d71fed3a26d\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"6ba1cedda0f7a9bd\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"d6989c0025cd64d3\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"264130511de314ef\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"53fada52950d1d7b\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"899ae1fd0d260dc2\",\"/knowledge-medium/src/sync/transform.js\":\"04052f86a4e0cc9b\",\"/knowledge-medium/src/themeBootDefaults.js\":\"ce3599e85911143b\",\"/knowledge-medium/src/types.js\":\"3d3bb938028963e6\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"fd4d5f461eabbce1\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"00527930a64b68c4\",\"/knowledge-medium/src/utils/array.js\":\"20d86df17e64f46f\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"0d4a02de5b3f3238\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"fbeebfe60d287dc5\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"8cc67c3142340ef7\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"68730959e6cfbb42\",\"/knowledge-medium/src/utils/callbackSet.js\":\"95aa808406724756\",\"/knowledge-medium/src/utils/clientId.js\":\"2eb72a91443591da\",\"/knowledge-medium/src/utils/codemirror.js\":\"3961669b91a9ff15\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"420e5174787a4d76\",\"/knowledge-medium/src/utils/copy.js\":\"8a5c96e9aaceebe7\",\"/knowledge-medium/src/utils/dailyPage.js\":\"ad436082016ef3df\",\"/knowledge-medium/src/utils/dbForensics.js\":\"49498f5c506e8ff0\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"1744b58cb54ba703\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"0c9f0ada4c82c275\",\"/knowledge-medium/src/utils/dialogs.js\":\"aaa9d25821e94fb9\",\"/knowledge-medium/src/utils/dom.js\":\"c97d2cd52d61bcb7\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"27b5016537a59cae\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"abb5d1d10841ec17\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"69e31ca09e05c328\",\"/knowledge-medium/src/utils/flipSlide.js\":\"3bea63a91b168b70\",\"/knowledge-medium/src/utils/fnv1a.js\":\"f783a05a8215a261\",\"/knowledge-medium/src/utils/formatBytes.js\":\"f24f0e8fd08f7d17\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"1a28d3001c6cfcec\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"bb4c598ee2858eb9\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"9d677eedf1fc0cb2\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"9dbc58c6884f8ab2\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"d4f74d1f6d84a9cf\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"1e06393dee004c67\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"31f378d98d476b02\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"5d15da84e1955c55\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"54bf988549f1cc8b\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"287f195902cfe321\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"6ce2e64a09700857\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"d4a8d4d8c59db8b9\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"870cc0215a2408da\",\"/knowledge-medium/src/utils/markdownParser.js\":\"d6df17ea6683b24e\",\"/knowledge-medium/src/utils/memoize.js\":\"b85474c08a4f52b9\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"ff43352cb1bf00a5\",\"/knowledge-medium/src/utils/nameList.js\":\"c739e4add2c7fed9\",\"/knowledge-medium/src/utils/navigation.js\":\"a76bddc7e686f8b2\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"ed32301cf625b649\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"8ee9f31448576f87\",\"/knowledge-medium/src/utils/panelClearance.js\":\"8e04b5de4eeb7e18\",\"/knowledge-medium/src/utils/panelHistory.js\":\"d972e8854f1e975f\",\"/knowledge-medium/src/utils/panelLanes.js\":\"7f8fb7f96b03e087\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"a8f1d732b6240fe6\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"f2c1d22adfc5b45c\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"63c825d6e4f1a0a0\",\"/knowledge-medium/src/utils/platform.js\":\"ee931cb31617e20f\",\"/knowledge-medium/src/utils/pluralize.js\":\"abe0bdd3ef8801e3\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"83b3cd581bffe7bc\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"216c03be77f3dd5a\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"d35dea651d167719\",\"/knowledge-medium/src/utils/react.js\":\"883b7f39e058d4c6\",\"/knowledge-medium/src/utils/relativeDate.js\":\"9679e68c93917bae\",\"/knowledge-medium/src/utils/relativeTime.js\":\"de7e67887770c633\",\"/knowledge-medium/src/utils/renderScope.js\":\"d80b5424f46757c8\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"2af237bcabb8d977\",\"/knowledge-medium/src/utils/routing.js\":\"ad39b39406388df5\",\"/knowledge-medium/src/utils/safeMode.js\":\"3a9af51ebbacc877\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"dfb32df6220bffc6\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"0d076d9322a8e870\",\"/knowledge-medium/src/utils/selection.js\":\"609e2d2ae95a4498\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b2dcc4aa774d628a\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"524a3bc17e4b0c73\",\"/knowledge-medium/src/utils/state.js\":\"742545704171d8a9\",\"/knowledge-medium/src/utils/string.js\":\"8c07b375de0231a9\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"4635a9035022a2a8\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f42f9616afb48617\",\"/knowledge-medium/src/utils/toast.js\":\"a980159e8da38ebc\",\"/knowledge-medium/src/utils/toggleStore.js\":\"efd4d0d279ce589c\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"6d8cb41d1ed1895d\",\"/knowledge-medium/src/utils/userActivity.js\":\"0846c929c6577243\",\"/knowledge-medium/src/utils/viewTransition.js\":\"bbb9714d44e641bc\",\"/knowledge-medium/src/utils/viewport.js\":\"d6b6c23ca01a938d\",\"/knowledge-medium/src/utils/webLock.js\":\"551b67dacd4d4ed2\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"dece3c2cb9a124d2\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"4778d0977d5f01f0\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"04b3be6c52fe7070\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"dd4f33250be7ac33\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"c2446a848f8910e9\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"fb15203a9319a144\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"3ee20764186533f5\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"651c54efcc4b5c23\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"6ba5695a286e06d7\",\"/knowledge-medium/src/vendor/react-dom.js\":\"0b5309256e4893c9\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"3d94d427f115e687\",\"/knowledge-medium/src/vendor/react.js\":\"1ded914d82836b86\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
