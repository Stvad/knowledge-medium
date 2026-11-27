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
		buildId: "f7e704da8c37-57fe8396",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"ef8415417bab27f1\",\"/knowledge-medium/index.html\":\"ef8415417bab27f1\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CKmuRdWw.js\":\"3d02a41d5523d408\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"282bbbd8218e8abb\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-zUS7dnjE.js\":\"e4336f9b79a28396\",\"/knowledge-medium/chunks/FacadeVFS-thDHZbB7.js\":\"550c002356c6ccac\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-COKxAeWx.js\":\"a2d1e43c9fc7b587\",\"/knowledge-medium/chunks/MemoryVFS-PyeGrvav.js\":\"83cd3fc2064dcc48\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-Bt_CaGEO.js\":\"278a870e1936c308\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DhEyuzWO.js\":\"fccbfc67f5dff472\",\"/knowledge-medium/chunks/Preview-DO5kz99L.js\":\"1accb6d99768740a\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-7uWuiETu.js\":\"b7cb3928647ffe8d\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-dFfAsXe7.js\":\"c3717d278c2329af\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-1kR3qzHb.js\":\"77b602e32fe93245\",\"/knowledge-medium/chunks/react-BQbBXBn_.js\":\"c4f5f72f10857192\",\"/knowledge-medium/chunks/react-BnNkfSsE.js\":\"83e9986a0d086db4\",\"/knowledge-medium/chunks/react-CR1Va5cv.js\":\"60d95671c40688f6\",\"/knowledge-medium/chunks/react-C_qA2yIl.js\":\"7ae23874468ead49\",\"/knowledge-medium/chunks/react-D_GgOx9N.js\":\"ee88672af791f5dc\",\"/knowledge-medium/chunks/react-JmslBl3Q.js\":\"19680afe6e664d56\",\"/knowledge-medium/chunks/react-Y2gtAkRz.js\":\"87eb0e9996c447d8\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-yspGn_2c.js\":\"bbae8129bda2236f\",\"/knowledge-medium/chunks/react-dom-server.browser.production-B9Zznzlj.js\":\"07f5cc73a04010d4\",\"/knowledge-medium/chunks/react-dom-server.edge.production-eZxjjl-z.js\":\"aa0cc227bebef0d0\",\"/knowledge-medium/chunks/server.browser-nBPDWYEB.js\":\"086f7332857e86bd\",\"/knowledge-medium/chunks/textarea-Dj3GAWBn.js\":\"23f33c65f430b7a6\",\"/knowledge-medium/chunks/ui-C1qNmhNv.js\":\"721bd460234c1b41\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"0cc1c89cb3a8cbf4\",\"/knowledge-medium/src/appUpdate.js\":\"957e8ea0937ad982\",\"/knowledge-medium/src/appVersion.js\":\"f16bd8dca74d9ffa\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"31476093ccc323ea\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"56f9ff1fc10a9f11\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"df0cf2927ca22b16\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"b0bc17e0713155a5\",\"/knowledge-medium/src/components/BlockComponent.js\":\"b5c35e578c77efa9\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"ac3c64e5b22b1c49\",\"/knowledge-medium/src/components/BlockEditor.js\":\"daead4e31e053169\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"4058903a9cb82836\",\"/knowledge-medium/src/components/BlockProperties.js\":\"90b2a1e7869c7826\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"4d4a196659e8c124\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"484e7333ddb4a3e2\",\"/knowledge-medium/src/components/DividerHandle.js\":\"e7531e0e33f9830e\",\"/knowledge-medium/src/components/DraftEditor.js\":\"763204858d27b720\",\"/knowledge-medium/src/components/GutterPill.js\":\"5cdfdf81d9191dd9\",\"/knowledge-medium/src/components/Header.js\":\"bfb33fa2686e25fe\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"aa43e0ed38f16aa0\",\"/knowledge-medium/src/components/Login.js\":\"c53d523ff0788057\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"2bb85827f429c8ab\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"066ac2fd8a9eadab\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"82e64f3760265b1a\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"accd50ec8f1f60a8\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"1ce47905b6fc2b3f\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"fc5a712c053c8aec\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"dce7af989843cef7\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"44287e4693be918f\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"c27acfd24f7b7d60\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"f25d076b3d5461f9\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"8204fdcd4df0ac6c\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"3cc78bcf7e78c423\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"b7f3141e8faaf5cd\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"c935cc9f91c3a860\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"3afdca27b00db126\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"d55574b37bbf8996\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"08fd5ceec69cbaaf\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"013ecb9f23f8b8e5\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"0928d9d131f344d8\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"ec259fbb22f65ebb\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"735c0e7b8da7588b\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"2bdd999747f777f0\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d78ad656fc0929f9\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"f511037ff4a67869\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"b07b68747a8d3beb\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"cf73a5c3a3933f6d\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"34dfcceb2a17a265\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"2e800443b0583ae9\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"0d05c55f05e3ace7\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"9a41b159cb54125b\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"da71013722df3ae8\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"40cc34a997ea0263\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"e7a05b8056a5d14d\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"bbab5ed95a802ce1\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"b60a92335a526174\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"315a2f57d4222a42\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"cab68aefb71bb0c3\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"39a857e35b417e2a\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"5e5ebce1b6523333\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"979f65cacae51bcf\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"7be7b61b3e758048\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c07abb4d66895c42\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"b5582f92a2f099de\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"86b7e2313ed56621\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"858f9425dc94dc4d\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"ced782e699c75e55\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"8843bd78e3764a1c\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"ccd97bbb24a9d021\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"411fa8c2d3987a7f\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3de2413e08717f46\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"cb9d84ccfa4375f0\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"fe49c0d7e02d2532\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"38bab5f23ca50b91\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"0d242229ffecfe50\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"ea44f68ad75f61d6\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"096587246b460914\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"5ea6dfdb70ca277c\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"36c9822d30ff8109\",\"/knowledge-medium/src/components/ui/button.js\":\"aa42698598236d79\",\"/knowledge-medium/src/components/ui/card.js\":\"3874d61ae0791383\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"ad3fd8ae567d52c0\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"41a18c93cb8c256c\",\"/knowledge-medium/src/components/ui/command.js\":\"445698e31883c9c6\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"9d5fd8a293abe835\",\"/knowledge-medium/src/components/ui/dialog.js\":\"b8b85a64e560000e\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"81e90c1216a55244\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"03bce9571ef34b90\",\"/knowledge-medium/src/components/ui/index.js\":\"6aac9d2025e53d5c\",\"/knowledge-medium/src/components/ui/input.js\":\"30b0dfd23a689d0f\",\"/knowledge-medium/src/components/ui/kbd.js\":\"cfc09a73b4380dbd\",\"/knowledge-medium/src/components/ui/label.js\":\"eb6d83b7a6838b50\",\"/knowledge-medium/src/components/ui/textarea.js\":\"19a7ac44740d2fed\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"ed7b9b52ee5f07aa\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"b75a53bff254bcef\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"7fc9d82c5142a2ab\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"a1984b8ff720b398\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"372f45481b40e500\",\"/knowledge-medium/src/components/util/error.js\":\"0db310d1ee66f09b\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"3de01a1a6c9fca11\",\"/knowledge-medium/src/components/util/suspense.js\":\"befc7eeea4c2f55d\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"660cadde4c3c84ee\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"d87af27aa4ccf9c2\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"dab61f00490d8afd\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"00bb8574328a6bf8\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"dc9624f9ae0b7e42\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"ff706f8b26acd79d\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"e9874602f7d1dd4a\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"72f186d89b1f83c6\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"66115e33b0a16473\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"fbcf741e55f8bb1e\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"1f92e0ce71c876bc\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"4f1f677da4388683\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"67e0b294958c0e93\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"8c0355316948d782\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"283d604a15f9c30a\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"37ab8881f580006a\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"1c2f199616249a3f\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"fe4bbf4b9fe1b923\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"ec3340846a9bd7d1\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"0c80197706813fb1\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"c38b179b8e2507d7\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"f92e60a497d183ba\",\"/knowledge-medium/src/context/block.js\":\"0c10ca1904a4e063\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"e1eed7bdfb526bc3\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"3375e31201c2beaa\",\"/knowledge-medium/src/context/repo.js\":\"d95113b9bd8b3b8b\",\"/knowledge-medium/src/data/aliasClaim.js\":\"aab609baf37a0bc6\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"84600db9b3a06757\",\"/knowledge-medium/src/data/api/blockData.js\":\"bdc0bdb414f747c8\",\"/knowledge-medium/src/data/api/blockType.js\":\"df9c56f9f273801e\",\"/knowledge-medium/src/data/api/changeScope.js\":\"e76ae773e2ff13c9\",\"/knowledge-medium/src/data/api/codecs.js\":\"4cc75e76b1856444\",\"/knowledge-medium/src/data/api/derivedData.js\":\"be62c3ad4f0fd747\",\"/knowledge-medium/src/data/api/errors.js\":\"7831dc7e7c9d9777\",\"/knowledge-medium/src/data/api/events.js\":\"5fd453f6a0a44092\",\"/knowledge-medium/src/data/api/handle.js\":\"6900db8cf09164c2\",\"/knowledge-medium/src/data/api/index.js\":\"4b66d05732d71315\",\"/knowledge-medium/src/data/api/mutator.js\":\"9f82cc84b4fcbc6c\",\"/knowledge-medium/src/data/api/processor.js\":\"6c3fd84a414f0836\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"ce02a27b2a5a9d62\",\"/knowledge-medium/src/data/api/query.js\":\"50dc008b8ca5a813\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"7f9f5c1a3d686d20\",\"/knowledge-medium/src/data/api/schema.js\":\"6900db8cf09164c2\",\"/knowledge-medium/src/data/api/tx.js\":\"6900db8cf09164c2\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"9c687945b2ba6ec1\",\"/knowledge-medium/src/data/api/user.js\":\"ba118d64ace9e34a\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"1820c8508177869e\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"747932df34940b4f\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"5da99486dc40c8fa\",\"/knowledge-medium/src/data/block.js\":\"a8cdcce8da60765c\",\"/knowledge-medium/src/data/blockCache.js\":\"56fefc64c9ca6536\",\"/knowledge-medium/src/data/blockId.js\":\"5a295f2978fd9550\",\"/knowledge-medium/src/data/blockLiveness.js\":\"79bfdab6849aa686\",\"/knowledge-medium/src/data/blockMerge.js\":\"21305f6877891bab\",\"/knowledge-medium/src/data/blockSchema.js\":\"7219d39c22d912fe\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"faf7393bf105783c\",\"/knowledge-medium/src/data/blockTypes.js\":\"eaf570b520e889ce\",\"/knowledge-medium/src/data/childrenView.js\":\"fdb1a75d4aa8c38d\",\"/knowledge-medium/src/data/clientContext.js\":\"ceeb4b6135a6daab\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"b77ef61c6d9df891\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"4a7a75b2e53ca3b8\",\"/knowledge-medium/src/data/derivedIds.js\":\"5663682184c312bf\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"b5f155c242d782c7\",\"/knowledge-medium/src/data/facetBridge.js\":\"941881eb92c5a73e\",\"/knowledge-medium/src/data/facets.js\":\"853610e3909d1c33\",\"/knowledge-medium/src/data/globalState.js\":\"14fd997873d670f1\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"ae0733909495e53f\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"fc07b0c7f7af227d\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"0a1c62e09094f6e2\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"7e31794a8673a27f\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"8008fc2c0c7f40fa\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"25ae3baa9183a60d\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"c8af2158fb3468ff\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"0f9a836f13f9394b\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"083d5da87881cfab\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"12e40da619d297a4\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"2f9467749310549c\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"756876c2fd4a8222\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"85fab47f048ba0f9\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"c566cbd2fa7add8d\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"521bed21507eae9f\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"ac73449ad2f76a43\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"2862a8fd54e10cb9\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"0a31f6b9a9694065\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"d0600dfd88f61fba\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ea40216bbde2b3da\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"f595a6f4d1764523\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"0e2dc8ba18b903ed\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"4ad606b12ea35aef\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"dfb1b85ee054d03e\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0d49b50a30ee4d36\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"87b8c77c434368b4\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"28c510ab992364f3\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"5b043398aaf86790\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"9ae064752ed02c7a\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"e5a94cc4d8a35cd2\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"43b53b0cddecb20a\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"b5e97b6840076bd7\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"bf6967b02aabe2c5\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"fccbcd47f4374b45\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"dd77b4f61ec91372\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"cef3892a4253bf07\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"bd0d6e53bc00e1d7\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"133de4470336371f\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"3d04e4f3705ec517\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"90f1a845870dad87\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"5ce24b95e42e16b0\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"efafe9fbc028fdc8\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"3a0927b700c71bd9\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"aa68c5b9512f759b\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"71e2d38acfa0e485\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"1b0322edd996cd4f\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"940f5af7ea83338e\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"9557c353a84af5f5\",\"/knowledge-medium/src/data/invalidation.js\":\"0c386f9a56d26a9d\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"7569b6fd17314ae1\",\"/knowledge-medium/src/data/kernelPage.js\":\"595b09024b56dc7d\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"ace3502efe074eb4\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"979e0ed4bdd3c66f\",\"/knowledge-medium/src/data/localDbStorage.js\":\"d242e41b74f54e47\",\"/knowledge-medium/src/data/localDbVfs.js\":\"ee88709608448f5f\",\"/knowledge-medium/src/data/localSchema.js\":\"a949167ce7d6c58a\",\"/knowledge-medium/src/data/maintenance.js\":\"7fdd2fc6f367de65\",\"/knowledge-medium/src/data/mergeProperties.js\":\"fe5e8b638fe421a4\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"7f46522ed61fc336\",\"/knowledge-medium/src/data/migrationsPage.js\":\"e21f899fb5f95a85\",\"/knowledge-medium/src/data/mutators.js\":\"082914161143067a\",\"/knowledge-medium/src/data/orderKey.js\":\"3ec1a1c9ec2ac940\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"1725590d6cb5c448\",\"/knowledge-medium/src/data/outlineSurface.js\":\"e51a97fc9d0b6384\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"2d3778525bf0a1b0\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"61a362eede71c01c\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"e4e382f9b73f2a40\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"e554d0709a75085e\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"a61507b509cc528d\",\"/knowledge-medium/src/data/properties.js\":\"5db2e454399707af\",\"/knowledge-medium/src/data/propertiesPage.js\":\"196f83122d8098e3\",\"/knowledge-medium/src/data/propertyChildren.js\":\"0e8e0f77994b7ac1\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"e027343daf42bc5f\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"ea1ccf75b90a4ce8\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"d9116b557ce7182f\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"223d43b7f9940ae9\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"d72db505e185dc1a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"99ba4db0480dcf74\",\"/knowledge-medium/src/data/propertySeeds.js\":\"7f1a9c7316dfc71c\",\"/knowledge-medium/src/data/recentsPage.js\":\"9dfd2ceb7497d77c\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"203a46692f922323\",\"/knowledge-medium/src/data/referenceBlock.js\":\"4fcfed44410d327a\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"3d0dd724b86d4e71\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"53e1e160c3b04d36\",\"/knowledge-medium/src/data/repo.js\":\"b5ea583818960cb0\",\"/knowledge-medium/src/data/repoProvider.js\":\"84ade28b5610baf7\",\"/knowledge-medium/src/data/rowProperty.js\":\"6bdb1000cbd7b21a\",\"/knowledge-medium/src/data/searchFilter.js\":\"b1202d0b6fab3a35\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"f84dac6eb12d1a6d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"ace3523af995b8fe\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"4cd7a454e717826e\",\"/knowledge-medium/src/data/structuralInsert.js\":\"6df48de21d104b41\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"3904d226a1aef613\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"91148c8665e1a069\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"e0cc5374aa46e660\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"03b1e05e51f09345\",\"/knowledge-medium/src/data/targets.js\":\"f2c8303c023714e5\",\"/knowledge-medium/src/data/typeColors.js\":\"1cf5f74a86dc22d6\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"067dfae4bbeec722\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"b972487d84c60b1c\",\"/knowledge-medium/src/data/typeExtraction.js\":\"5717f33cda71802a\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"647825568dc432b1\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"6056221445b46059\",\"/knowledge-medium/src/data/typeSeeds.js\":\"490d650a69d85155\",\"/knowledge-medium/src/data/typeTagger.js\":\"264b52dabf68d43d\",\"/knowledge-medium/src/data/typedRecords.js\":\"c62976a0fb5c6ede\",\"/knowledge-medium/src/data/typesPage.js\":\"dbd090a04f03bf0c\",\"/knowledge-medium/src/data/userPrefs.js\":\"f4d048a35183570c\",\"/knowledge-medium/src/data/userSchemasService.js\":\"02b121c3d979ce74\",\"/knowledge-medium/src/data/userTypesService.js\":\"0213d3ce5bd64497\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"538d701d099ec535\",\"/knowledge-medium/src/data/visibleChildren.js\":\"a9f7595be7522932\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"c62ec2639b1a3e5e\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"58a391f3a52de429\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"51c39cc2196e8341\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"09f532adb1a33d3b\",\"/knowledge-medium/src/data/workspaces.js\":\"e267f3fa30813420\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"f5763d863a742b58\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"0dd197bf5afdc93f\",\"/knowledge-medium/src/editor/atTrigger.js\":\"1ff7b17294d254d1\",\"/knowledge-medium/src/editor/autocomplete.js\":\"ce50e0f7e37395a9\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"b01feea7f0af9558\",\"/knowledge-medium/src/editor/contentFlush.js\":\"4e3cd3160b5c5c99\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"9bbd0345a5a1052f\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"5a301510df750cd4\",\"/knowledge-medium/src/editor/insertImage.js\":\"548af5b5038e73de\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"4aa32514e5d67a06\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"aab14423420d2e81\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"13936825ae2b6657\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"6bac1a167049d693\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"6a734317dc4a48d6\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"e1ae6c1749b516e3\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"67a648e27eab6f40\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"252d6c3c31385f37\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"4f5dcd4180f5d1e7\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"b809d89535c4e428\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"01b19b9c08c43ec1\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"b6bcb334892c759c\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"8e32cfba61360a4e\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"4ca59d465e0356b5\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"d47e07e39a69b0cd\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"709be56df3ea4647\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"91a31b92925e647f\",\"/knowledge-medium/src/extensions/core.js\":\"66b46457e335ff00\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"16396c87df3e74cf\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"31f465ae0b3eed1a\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"acc4c4fed5c410e1\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"dda560d4958c8f38\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"ac477aa6f63efee1\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"dd2e39f17985a004\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"3c61f52ec87b937c\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"db6f2dd10af7479e\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"079cca200e1453a5\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"4b161e0d8e0a8cca\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"5adb3fa3a221df44\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"c9cc37aa4236c4ac\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"b73567c5c046e354\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6a81d38351efc440\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"c76c7c950de1b0cb\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"df977689361ebd57\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"da55de98c0dfa835\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"bb9a51f3851c1aaf\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"760b8cf21547e96d\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"887e49563314b9c5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"0cc0b1f5dee930fc\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"65a01892f557040f\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"48280985ce09abab\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"e7c3de04e6f8db51\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"c7e90436570f9b94\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"6337bca82c15783f\",\"/knowledge-medium/src/facets/facet.js\":\"20f44a6c95db72f2\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"f994cabbd99ef7fe\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"7be11cfebeae26a4\",\"/knowledge-medium/src/facets/togglable.js\":\"661770925944dc65\",\"/knowledge-medium/src/facets/variantFacet.js\":\"53f7b755949eb2cd\",\"/knowledge-medium/src/facets/verbFacet.js\":\"59c403b731543f29\",\"/knowledge-medium/src/hooks/block.js\":\"de6eaa1b0d224241\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"bb4eab67658a6749\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"2f726aaf3d26a28a\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"7b177a4dae7b1c32\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"6890076b43301ced\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"e9ab1c569af9cecf\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"cfe51029c423bc9e\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"25a00f602789ce88\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"5945fbdd4e5d4e9a\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"2a7a0989e94bd1e4\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"6def01b3b882640f\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"2d2e54c9792419b5\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"d07901ec2836ef6b\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"547315e23b1a8d94\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"98b7c55e2f5da571\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"a6e189262225e939\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"0f8d0cfad0b1a1cc\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"81348d83d9c7ae81\",\"/knowledge-medium/src/lib/utils.js\":\"209d6c6601e541d7\",\"/knowledge-medium/src/main.js\":\"bf154e5140e1f4cd\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"0409ee9bd351bd2f\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"72c7629afd67d82f\",\"/knowledge-medium/src/markdown/context.js\":\"8314364138696bfb\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"2917fa0260e21bb3\",\"/knowledge-medium/src/markdown/extensions.js\":\"645e6c9d24f590e9\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"04b5a9bd815da7c0\",\"/knowledge-medium/src/minimal-editor.js\":\"28c0db25b30dd70e\",\"/knowledge-medium/src/paste/armedCut.js\":\"be2326b5071c568c\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"44b005049be27955\",\"/knowledge-medium/src/paste/clipboard.js\":\"ef041fa62e1d9d40\",\"/knowledge-medium/src/paste/decision.js\":\"3b104f180e9bb277\",\"/knowledge-medium/src/paste/operations.js\":\"0fbb2a97d3cca0de\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"a6170c3ef6713d4a\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"cd6679a39e03eb23\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2dda0ca261ed03cb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"ee6fe5ea6702d67c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"6d08656233e4da42\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"57b4c02ce1585acf\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"fc23701f091a8a35\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ee8bdcd30efca2c8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"5215f66ead09f581\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"368142e951b1b5e1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"3062406f73398f74\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f9e43669e0ad3570\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"72d013eb34a154c2\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"2cc7cb48ef8cbef2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ab9d43ba4d90cdda\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"b1f341cd9b3f53a6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"303e1183d31783bb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"754b1cecfeb4b6c6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"df849b5b6a12d70c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"2c2616512e24a965\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"07891c23e780e569\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"fe405682ededaf46\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fdf1a1ba3720f95b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"b20b204ccc5f9789\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"7ee12874fd5c4e8c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a6af1e8683e0de9a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"60fe4fce5d9dc45e\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"829848d120dc202c\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"b26f78dc11a52f70\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"2733ca51ca067442\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"caa754ee526884f4\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"aa96549da28b6b89\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"dcaa896cb55da881\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"cc247108c3014623\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"c54658024a06a055\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"66e39ea585c50e74\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"a039451d1bd3a7d4\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"c810ef54076554b3\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"c07c67854ea95496\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"262ce0afc06c29d9\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"01f27a8a48224944\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"80e40022efd0b81b\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"4e90999420807e03\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"59e6cdd3e75f072e\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"cc8db6b6e41ac601\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"4c5718cea9b0abdb\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"bfdaa7afb7834c71\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"b2be62b43dab3bcb\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"4ab5ea84ac0be6db\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"9509fb198861a8fe\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"37b5ccdc8aa5ac9d\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"81e3b5b895bdf37b\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"44e9a7870747e482\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"d38a3db8bb7b6ddb\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"e905923a93119d66\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"64eba0e1a196646e\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"ecf3f3a218ca4ad8\",\"/knowledge-medium/src/plugins/alias/index.js\":\"efbbbb7639382c98\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"ff5461ab5ee2b7dc\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"84cd68af2eb1905c\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"daeff377a5ebf143\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"c289c951df5c6c10\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"7fb7ef0266e181e1\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"63b7f569ab991e7d\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"3ffa2199c3f1e921\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"2c45a3b53d0981f2\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"6f4ad0eceafa60ed\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"f0873ab6d868c067\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"c54c7d17a5051b2a\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"7f0710ada51cab36\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"dd7fc3e61bd68512\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"57f9f4ffaaa6a9d2\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"77ec2472392bb838\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"b54f78855a8bb7d2\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"f1c5b55dfb89b540\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"196cc9fc9c8c89b7\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"3c6d623b40869a2e\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"3972592699a8a376\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"4ea43e1172aedd08\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"5709cec85335e95b\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"de45251bcbcc922f\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"dbf86d46960ccea6\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"3802f787dc14bacc\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"921ed99c357e166f\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"a4f6d00f4db7e1d6\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"21a26a86fec6763a\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"f65ea2401bb0264b\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"e25fc68f1e470293\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"e6652990ead70bfb\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"d07b486d54752d6b\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"3b03e03d467efe99\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"51f7e97e29f7affd\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"40366a1fc02096b3\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"77319baead613790\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"7f523fb5933a76b7\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"ebcad3af9a1a7c43\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"7f5a435a01405044\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"dbc634bfc097c52e\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"2a46da3820bf7eb6\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"62c10087a116d9ee\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"69d57205ed477ecc\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"62977592862487cb\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"af3d5ad1b11a7ceb\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"6b95466b47770993\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"7f6aae2861ac2788\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"f1cba8c9edd075fa\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a2c88b8bb251be5f\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"c927de38e5537520\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ce785ebfda1988e1\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"722b05cd5b6c7fdd\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"cc176ea7ffc19e74\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"52ab8d93d3f05d53\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"b97b4bfccc5c98d4\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"74a5721d266aaefe\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"07f515ffacd30157\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"5fdb8425008b9075\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"17c138c09047a45e\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"e81fd7609df712c4\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"fc188bd741c2de88\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"e2a3d8c5de3a104d\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"4c3077f44d9bb8f8\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"b87215a6c493bc42\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"340cfadeca8fb5e5\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"461ad6024dc98eae\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"e544ff46bca10d34\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"21f4849b21248271\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"7d68156f79d690cb\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"95aea6042299a460\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"783b2c1889ebb832\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"62ae9b1919670312\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"9c7a1dae1409f63f\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"85b8a596383e28ea\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"ee50de2a1079d705\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"4f35d4740a854d9e\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"14a23a4a1e343c11\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"5c8e7c6d7dbc1042\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"fea0f2f3a0abbf93\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"2bb62d220df6eb6e\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"2c67b182477a3e55\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"c6d2af0f81dade56\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"60d70001e3d92e29\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"70c1d00aa2b6acdf\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"380af42aac00f399\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8ce638977f77fd22\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"ccf5b6d8677ff4ed\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"fe359bcf18b838dd\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"e0ca79b5699ed23d\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"feed778324206537\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"ab0ed94a085a302a\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"4479b9d5174557e8\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e7ce4e032940825b\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"3631b5961aea2e37\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"da9baf70675b456f\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"a5f89e0b7d432e3c\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"7fcfbc5c58662f9a\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"c035ec08158a2ffe\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7cc55fb6ff5ffa5f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"b0f0ae55e83955a6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"acc48ed8d683f7e3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a2a648e77df1a2be\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"d0abe0fe9daedb22\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f3e0e3406fd0d982\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"1b9f220dab64b894\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"abc7c6f32b22187a\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"cdf0f981f4df63bc\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"dec64247e6146e19\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"35512c4f4173f9f2\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"1c420c1a7cb2478c\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"c54930fe83ae931d\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"386837ff173e3672\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"29558b613c396fd3\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"1d92551a1c7ce8cf\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"4ba3a9045b36903b\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"b4085a3d3893b4e1\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"44d79d6a0bfa36e8\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"b85fdf9e85156c29\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"0788e4252a76c859\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"0ff10f3f06d61f2d\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"e009680e483e2113\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"4c7527067f38ce59\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"930bdb81b8ea0004\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"680a2d1a525b9df5\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"cb57a227f3270ecc\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"84c2c3d84f65b6f8\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8f5b42edb215f94c\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"171d08377ddcf12b\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"ec9ee5e10eb432ee\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"0ece971120083694\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"77efa67e77ef24a8\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"a3587d16a4a52a83\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"2e6a297e1693db14\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"f5fcde093d0ab6fd\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c46cb9aea966ff10\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"34bb42eaeae2c89a\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"625bbfee252769a0\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"35855ea544016589\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e6a1f6aac4ffa0cc\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"2151d59f3b755ec1\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"deb490103a950f81\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"8aca2cd6e93a670d\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5d5fde3781e96c56\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"3b242e3da527dc5f\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"026f692d08997631\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"a54050e6f168505c\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"3fef69a3785cdfdd\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"c83fac991872a9b1\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"2dc4af8f32b3d223\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"235fb0e6e5f9b212\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"d40bc681a4f2df92\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"21fee66f1db0b0d5\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"411294fcd111aae8\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"f1cd76a8f29923ab\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"f8105354ec0d8256\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"091f7e1bd576ea0a\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"cefcaffe80de62d0\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"57444ae1f0693903\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"12b33bb1059901a4\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"ce32aefd1f25f184\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"49b419014f02c566\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"e81d1c76e9fd8af5\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"74bcf5587f5f81e1\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"9927c782c5106067\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"922b29fab85fbc91\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"feb1dbffad169327\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"f5f0e65cbf03f486\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"ea99a6ce6ee05bf6\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"a53b9959b593aaeb\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"2b1b8130b8a1eda0\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"11956cbd8952f6f4\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"7706d397ed55a4e8\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"39ebd8b8a43353b5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4c424e3c616f4308\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"0064a21ece3bf907\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b244cd22a8fe421e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"89c709c14900eb20\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"e8bec40bfaedc54d\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"c04679edbc231806\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4ff44619e14b73cc\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"5cbfa3f9ef23ddaf\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"b180679afa3fe46f\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"ea77b7529bcf64f8\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"f96db1756920b139\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"07b4f4d05653dfdf\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"b0a03c56ccd866ae\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"40ffb7ba37e95098\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"358e5adce3a77a72\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"c090ad8f8401cda6\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"e0932d662b9622b8\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"f536844da8edaecc\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"fceae55d3ee32c74\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"44b164223c072f91\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"10321795ac339c8b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8cd04df846c379b9\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c2dbed11e382965f\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"475eba7b096ca191\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"a83a3514e5894b18\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"75cc8f70cceb3ce8\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"27bba176a0c07bae\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"20f654eeaa977044\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"fd162179ccecd8f0\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"46098b90ebf46746\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"0f5d8121dce22680\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"e7c91adc4041c4af\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"4be307287f335125\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"3fb56815e5e9cb2a\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"dc19b786bf12cc37\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"34e17a8d0f2c64a1\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"45af903ba48be085\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6d0237ad6577731e\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"53067c2dbed5e4b5\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"6c0ee492e6e2a89e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"cc73f384ec0a80d2\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"260ba86282e666d8\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"b7d67bc349a8422d\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"520f3df7660c83e0\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3e6345a2d53bad55\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"1b1f565cb973b92a\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"0acbe1f6940edccd\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"756f0a9d4075235a\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"99d26f2c35c35506\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"0272df649c1f6e17\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"3f08f6c88e423e3f\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"f3aed1f5eaf93ad9\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9dc6621f642e4b20\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"168619e6776c4c59\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"06b1d4dba3e5dfc2\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"c24144f2b0ed7567\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"5add64d386af5068\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"5237af4aff13616e\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"bbfbf8cc606d1792\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"f3413a9f82c4dcf6\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"4aafc21e62f11da7\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"7d251096cf2719b5\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"9217c94aea53281f\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"b5aa6d614b2e1b97\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"37b1d9f6447d1368\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"224e44fc8bec8a59\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"7bb309a48899dcd9\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"eba7ddec98ec04f6\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"4202b3639a22d7de\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"eefec9a6847f5454\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"fe805b3c05120dd9\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"a9d8c05780ba666f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"898108dbd4102f99\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2e2e8afe90475476\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"e3dda3091f25884d\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"0d144bfb9c04a9e5\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"7cf00523f5b65523\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"15b5eb3ad31b84ac\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"2f698cb611362fe5\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bb6753266b6b6ae2\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"b82c461148e5983e\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"6876ca7a77037055\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ff8872c14ddf2fa3\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"9cbc8ea3ff954fae\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"4cb3bc6e15af20cd\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"b1110ae7a4fc7807\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"8658452443dd79fe\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"69da7d6aa63166a4\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"d3545406489eae12\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"45c744c4d43892ac\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"60cd80f82202fcff\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"e0083fc90f21a618\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"987d05e83130713a\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"524aaf8a951e929e\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"d1fccf4b88067d1e\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"42e6c6346a92a88f\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"cdc0a3151df75089\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"d0021bac6c18632a\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"3390a6319992493b\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"fce3b8bd2b1d78bc\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"569e6488d96f318a\",\"/knowledge-medium/src/plugins/geo/index.js\":\"759e2a22a17c6285\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"bbc58a2c385111c1\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"bbbe9d0a5566a7b4\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"5e6922e56227fe70\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"66fdf6a3341f25f0\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"95e76af2257deafb\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"594cf25926fc0f2e\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"6805da539bf3ca93\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b55dde0075185200\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a733cf2f89666840\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5120e7ed154beda7\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"20726b3f55a44147\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f23a37d9ffd78bf5\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"1cb67502ecb952ba\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"6dbf6b86019664bf\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"b40bec33520f62b9\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"2bace4c796d5319a\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"f53f491336da0e19\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"11906a4cb972094a\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"5909e59d0fd93818\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"818f2ff629a78842\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7c17fd9aa499b54c\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2570254331d3093d\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"120db03efabd9e73\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"963f6b893567c800\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"fe78dc9b286fcef4\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"c3e46dbe1151f6ac\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"c62f862b0fda9149\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"58e5a0ea080b6c39\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"576cb7efccbf7e55\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"922736be936a0750\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"ee96ff650ec98cab\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"478d7c59b76f2ab6\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"1cd0932569ba1727\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"af72f11cd4fe6ad8\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"2ff5f7a05bf04629\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"7d11fd93421f9435\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"8574a4095226451f\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"783a30544616f06c\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"b615b580cc6ecbf5\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"76d43b088fc51d95\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"6aadac1bd28e349e\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"452f80c26b14542b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"51fd4b7fc8a5f967\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"0fcf936d5c320fe1\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"c51e872d0ffde321\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"57db4e5d63aff78e\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"89d28fc424aa3e9f\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"001993439ac5a07a\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"4c78e004b2fe17d1\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"a20f108914fa7d88\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6897764290bd6cf7\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"1742c0a8fdf08da3\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"a87d661950c8bad6\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"08501cea0ca8198e\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"6e4d1cfeaac75bfc\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"52e3f5d849d6fcc7\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"7ae84b454b711559\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"b65d06930c9af021\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"d99da3bd7769b8e2\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"b2ea56526a6f3b08\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"7c3570b44d4cf0b6\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"ec34fe01f1ba8f6e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"e18beacfe6f1c274\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"4c0640765267ffc8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d76b5ffbc177484d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"83518f9e1924af29\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"44a0522f781c52c1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d6cd3d3c2f920333\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3f6945703ac5e043\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f2d230756b6bb239\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a8f06655368ef1c1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"2e555705cd073b6e\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2c72437b1f1be7cd\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1cf0d31208dd8ee1\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"fa57a680213e9bc9\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"8270df3bbdcf993d\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"f110297c4c44f664\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"d2d7f451fa454c23\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"150c0a722d92a9cb\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"7ffbe5555f279f7b\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"35cf26c6c7710d78\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"19c6a59d735d89a1\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"6958a04273549f90\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"4c57fe4d083cf7a0\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"83809fd6518ca5d5\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"c70b59bd8f819c6b\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"395769cbe4a0afa4\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"1cbf96700103d34b\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"db08ad968d3782c9\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"a70e7ff018b80454\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"84550e512c71dd32\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"a9234d8164bcaa2d\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"c02c44876e73b4c7\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"b1126ef9ea06b87c\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"f0c03f6d400fc3e7\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"8af48ed40036a159\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"b2c6b7c25e8c54c3\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"7d165448a3282edb\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"943727dc68874ea6\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"f93498f8138115e2\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"fc9a5bca49a9fa02\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"01176616fe93efbc\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d0583b949c790141\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"f06f88d720fe86b2\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"a832dc2e18e4f44a\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"770c1d758d408e05\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"c2daee87d3a64006\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"26351b08c037cb86\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"daf5a93222f635ef\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"043aefeb8fe6b007\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"5e3bc4e47c0bd1c8\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"26bd11ffb743a35d\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"c2032c80accb1b6f\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"0c4828a85901121e\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"77a59fd2c4d99ffd\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"c9bdecc072779571\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"3fdca26d619263dc\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"36466da7b741e03f\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"d611766ab2fc325f\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"8678d5dd23416c60\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"b1d5bc30e8267e86\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"c09c6e186dafb131\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"e3382e5370a2872a\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"9c84028d5e9ab96f\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"bc7f60f0165deb2d\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"0597fa440cc476f9\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"5cfc086a0f6ca68b\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"5f41b270f3823f2c\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"8794236677573e02\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"c57026ac142a6b8b\",\"/knowledge-medium/src/plugins/recents/index.js\":\"a571e21c20ced785\",\"/knowledge-medium/src/plugins/recents/target.js\":\"295393a513a604cb\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"d164d8ea0bbe8c01\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"8803c1b72d5353ae\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"cbfb72c3f9a353a2\",\"/knowledge-medium/src/plugins/references/index.js\":\"829503d55fa3324b\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"01e930267036c0fb\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"e3ca629918989d73\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"c244903ad4daf17b\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"95e99dba5d62268b\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b340cd7b7774d443\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"0ad76b7a9c6236e0\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"a65da373ffc1b424\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3f4e49f4036c5491\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"0d29669c6154e274\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"4b79417b07f4157d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"757f31148182becc\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"590adfd9ddf3d1d9\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"645ea3f0364f2f59\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"3603847b7992b6d5\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"4b3502746a2a6ab6\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"0fda3ae254edf231\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"b87f40bf8d0d2d2b\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"4d0e048783f062e4\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"13fbc4e3aa1096a7\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"ac3cf1e88b0a44b0\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"a5565dbf759069c1\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"01600bd4917b062d\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"85af0c11f3b5bc44\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"29aae0f0ca88078e\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"0d9f5471bdaa1ad4\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e4d824a640dade6b\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"be53211d95afc0e8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"7551f16d75c7846f\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"c84c030c37618584\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"97a789696152c91b\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"b204d15326b95c78\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"98077bf677472c76\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"087367b52ae24f6f\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"73aba0330565dae4\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"7d837cc4cd2aacb4\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"3fd5a1dc26212a26\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"88a5b051cdffd5f7\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"69ce11f8635139ce\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"3f83eaad49bac3c6\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"e912acff7ff7d902\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"06fbff55f3e3d6a7\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"74b967b06510b550\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"32cdae180b074506\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"c05553e9864ee62a\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"0978172f6a5aa9e8\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"cf758f7932ebdb59\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6460e54f1037c330\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"c18f217e0e6f4b7a\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"65b04f794b973a9c\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"4920324979ab881c\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"aa5b7c73959444fe\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a6eddcf62b610d3c\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"8f2bf9129d05dd93\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"29de2c95cac02ac8\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8743fe62417269f6\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"a737782b43d53e31\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"f428310fe509c322\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"d7d5b10dce85e97a\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"6f639367b5955053\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e430752f4b87b289\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"16c73caaa156cb40\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"9c4cd5b7df9818ea\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"3cdd57c3e2297487\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"f648a7cb2469ef60\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d31387cff3e8edc9\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"f0061d801911317f\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"88f7b6d407fb527a\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e05f46518e9a0e56\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"969da4b0ff5a82ad\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1a83790d7683ece8\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6caee374a0e4ab26\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"e47973756b777c35\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"6d779bf95213519c\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a3c6c18d5f3cedd1\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"9fab9f9ab0caf008\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"877f93ee8c081bde\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"462302a69aa85ffa\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"a5680b3536a911b5\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"2f0f3901b78eb6c6\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"f40784f6d5db2858\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"7e5478c74287ffdd\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"0ffd1fdb167ba148\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"ea41ce839e0c197e\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"a5500cb702393eaf\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"5068c98a839899e7\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"99c390c8d01e0fa1\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"49f4398c2c6d3b49\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"59b8aba5c23b9e82\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"f1ba4bc2b9d98370\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"33bf4694fa061dd6\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"c6625dd9f64b970f\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"37b2fee9cf9f3c05\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"94c782c3b2f19fd7\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"a40515a3185aad9d\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"237ce1fa476647ad\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"8e486d5d1f596119\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ebf0f8eb4e25a7df\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"2bb32cee1cc2afce\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"58be4b9da15b7bc0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"ca530c165239cfc6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"99f18884fa26f686\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"0ba909626724bce8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"16d38b73d491efbf\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"a3ee34924f0d7849\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"eaab3d270ead3a87\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"367b6951c5528aeb\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"0f6b7512f2db3b1f\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b1e99e43a5326395\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"d026d976cc09d8a1\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"9950bf08916b5b46\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"73af39b80e12063d\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"d015261383a7c74a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"f6bb871e1cf1e516\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"a166e12cee8f4341\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"cd11549d15a340e9\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"3cfbeca12019db5f\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"731933795115486d\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"ecff884889235c78\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"6f1c78e8931fcdd6\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"45f368b0096e6f23\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"242813183527bd65\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"156cf42285e3a7c5\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"09d9e53f925aa348\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"d6ead48d0be28cd8\",\"/knowledge-medium/src/plugins/tables/index.js\":\"7cbb7d4056a1c7aa\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"bdb58ec64d7683ed\",\"/knowledge-medium/src/plugins/tables/model.js\":\"22fc084e4324e17b\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"4173db51bab742a0\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"55f3ca0e80aba6a1\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"3dfa95aae8be4deb\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"3433a87031f6e641\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"ede879bd15a65aef\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"199b74e8d08780cf\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"adbe1e893c7f50a6\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"a116a7ac5c36e7aa\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"83ee741350efaa7f\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"e07b27499b5b207d\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"ff52db2f382941e7\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"128ce676c0f5b4ce\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"07b91ca32998e9ba\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"dbb9bdc476eab4a2\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"063de0b164f6949a\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"44bdfd05e5cb613f\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"0af0455c4a86fa52\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"946316cd88c651bc\",\"/knowledge-medium/src/plugins/todo/index.js\":\"35b9839fe929b548\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"e977dc0a619cdafb\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1ffd155323649105\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"7c33a6be472262c2\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"8efa0f09c9e5c141\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"640e6fcad523b0af\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"ce2366271b8bf42b\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"8215f414a2474f21\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"fedd671847cc7740\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"533f5ac2b8801fa1\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"d71afaabdcddcb68\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"43077a6c24e1954e\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"5d7f7bee19bab3f5\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"c788c0e4d40a91fd\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"7dd1142d2e68f1a2\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"d86fff05571b0ac9\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"8a52731803021f6b\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"8b03a527ea2d651f\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"5ac682d045d15fda\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"03531de492a9f95b\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"9c346c5ad64a7002\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"4b04bca1ab9b6494\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"386eb6b5cca82412\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"cebaa0ca1ddf4861\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"59fe5e9e0551c3bb\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"e48287e9dcc6bbf0\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"4b0751ad093113a1\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"d5bf97342137f6cb\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"f3f90f9b97f53cfc\",\"/knowledge-medium/src/registerServiceWorker.js\":\"0c0e15205d47a53a\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"8a0f5590afcb41bd\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"a9719a6fe11f8d4d\",\"/knowledge-medium/src/services/authStorage.js\":\"9715f11077ceb708\",\"/knowledge-medium/src/services/powersync.js\":\"b62eb0fbe872154c\",\"/knowledge-medium/src/services/supabase.js\":\"41096fc745fa2877\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"92020b2138a3da11\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"fd69f1931d16d380\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"8a8156b464824563\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"eed022757bc4b8e7\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"b5ee81838d3a7519\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"02b87449027f2d18\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"3a727d5174079c36\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"980f064b457c6132\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"794102687dae07e5\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"d5c70be1ace35684\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"2cf94640770ef54d\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"d9464d68e3c0b5f9\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"9cabaeeaf9bff1ba\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"a8ba1a67572602ed\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"9158d42a0df67eb7\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"8b489642640baaff\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"02ae7ba799461a05\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"6263a7b0e5f58d8d\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"262c0dfe55db049e\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"446764dbca9af840\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"b032188ab63145db\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"ee1d4d1dc3686a15\",\"/knowledge-medium/src/shortcuts/types.js\":\"dce548f1514269b1\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"8aff371e60fbaa41\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"8f0c3f9169514b78\",\"/knowledge-medium/src/shortcuts/utils.js\":\"94decdcbb9b88f8d\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"4f58447693b081cc\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"33c3ec6d15c431c0\",\"/knowledge-medium/src/sync/byteTransform.js\":\"3b073c5c8aa47818\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"c95e6690d79641c5\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"f760135430444701\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"eebe67fcf127d0d7\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"845328242c548ff6\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"1a89463401ba6dfd\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8c0a94bb81f5365f\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"094547746cc900e8\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"faf9ce126cce9963\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"9429cdcde72c5a31\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"87bd4b07f082efd4\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"fbdcc4b67ab732b6\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"90733fc5df0db972\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"a60d2eefcbb89d22\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"bcf1bd22c769af99\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"f21f7eacd9a937bb\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"791821f1e3b88c8e\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d7698b17ff744674\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"6365f12b8169b57f\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"420ebddae5cdf4b8\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"27df1c41c7a5882c\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"07490c8706330024\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"885d4059cb80a22c\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"8beb5d0d199b5aa3\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9945bd52aa7f5358\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"b7290da8bcd89afa\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"489faa9da946820b\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"8b60d3bcf1d12d9a\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"088acbca2700fa0b\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"108d77ed6f0fe6e8\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"8448245818728253\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"9ecf8037592ece18\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"9767e0cbcd85bfdb\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"a4a5d58cd0e93cd0\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"5e1d49db4fb85477\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"85bf92d3527200e8\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"cefba56acd56a5a6\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"60e9f645986ddbe3\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"794bc9a48c80b63f\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5b6058b45c956151\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d54a2fd75bd39d01\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"c568b86ec5d32a3b\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"3d5cd4866aaf6267\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"55323c66aa3761c7\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"00111c3ba6dafe91\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"f030da104e28d5a5\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"9ce3ba570c314bc0\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"6ca674bb8f18714f\",\"/knowledge-medium/src/sync/transform.js\":\"1e36ee34a902f960\",\"/knowledge-medium/src/themeBootDefaults.js\":\"b84be55e40cad6de\",\"/knowledge-medium/src/types.js\":\"51ac0440d1601fac\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"cccb0af2e4d9eb43\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"2e06e0455cff3ba1\",\"/knowledge-medium/src/utils/array.js\":\"1dc5195e60198f20\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b149a56d679887c0\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"446cdfca051ae271\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"8336ee7907f3726b\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"b06cc58227c7213c\",\"/knowledge-medium/src/utils/callbackSet.js\":\"b9cefb6b7a7ba184\",\"/knowledge-medium/src/utils/clientId.js\":\"e01ede3efac5ac6c\",\"/knowledge-medium/src/utils/codemirror.js\":\"b632aaa5a788baa4\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"5da6da1c3049bb0b\",\"/knowledge-medium/src/utils/copy.js\":\"7db12a8961c25a52\",\"/knowledge-medium/src/utils/dailyPage.js\":\"13208bb0f38fa357\",\"/knowledge-medium/src/utils/dbForensics.js\":\"14e67b768cbf0acc\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"30e1601c5c2b180e\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"e8c9ade417501661\",\"/knowledge-medium/src/utils/dialogs.js\":\"9263ed4b165cb27d\",\"/knowledge-medium/src/utils/dom.js\":\"0e4e8bb2a6d54611\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"44d7a74b79b3d772\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"3c9aca42611ae84f\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"02473e200d2b2d30\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"171bfaffd7e72bd9\",\"/knowledge-medium/src/utils/flipSlide.js\":\"864ddd82740a8c74\",\"/knowledge-medium/src/utils/fnv1a.js\":\"cb2bae8a59d43b78\",\"/knowledge-medium/src/utils/formatBytes.js\":\"dd1760b6d9cf408a\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"6e1db9701410d781\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"d2641f64c7f9bf85\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"fd6c47737713c338\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"51a07a3e1a152a9a\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"c0cc09d06f4ba505\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"4e54183c9ea9dd38\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"c72dba0deb2ac939\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"0895bb42f0e79ea8\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"4343732e76203634\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"e0302bd7f5e466a1\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"b86d57785f40626b\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"9736dfff1212739a\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"8d794341af54ca22\",\"/knowledge-medium/src/utils/markdownParser.js\":\"e94a0c118ef1a343\",\"/knowledge-medium/src/utils/memoize.js\":\"99a77ef8608798e1\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"63d94c9fe8f12142\",\"/knowledge-medium/src/utils/nameList.js\":\"374511aa17676d0a\",\"/knowledge-medium/src/utils/navigation.js\":\"b964ea89a72e5868\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"4b066b1ece8374bf\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"9f948bd4058422a1\",\"/knowledge-medium/src/utils/panelClearance.js\":\"4dfac04c9b81793f\",\"/knowledge-medium/src/utils/panelHistory.js\":\"509dc393a999ceb3\",\"/knowledge-medium/src/utils/panelLanes.js\":\"c383a0c2defa2252\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"10cda40eec77d26a\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"0120b15bf4d2569f\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"0a36b46e94e71b9e\",\"/knowledge-medium/src/utils/platform.js\":\"01e25420707562ce\",\"/knowledge-medium/src/utils/pluralize.js\":\"f66ad3f5b4dd8982\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"ab5b4cb2a9b8d3a3\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"609c80d45c7502df\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"8788d5e6bd3e968e\",\"/knowledge-medium/src/utils/react.js\":\"e51ef096628e4619\",\"/knowledge-medium/src/utils/relativeDate.js\":\"fa1f5714f4c53645\",\"/knowledge-medium/src/utils/relativeTime.js\":\"aed426ba3e2323e9\",\"/knowledge-medium/src/utils/renderScope.js\":\"a224f556f2161c8c\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"6154b9a532bc1124\",\"/knowledge-medium/src/utils/routing.js\":\"7257a603fda222f0\",\"/knowledge-medium/src/utils/safeMode.js\":\"c204dff0baa93add\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"9971687dbae88c51\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"3b7cb64bca06122e\",\"/knowledge-medium/src/utils/selection.js\":\"d693831b0cdfe964\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"239096a0adf14876\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"cca649177e3cead5\",\"/knowledge-medium/src/utils/state.js\":\"faaae82361307d34\",\"/knowledge-medium/src/utils/string.js\":\"21229e61cdeaad21\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"2f233a6c5324fe22\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"6496feae34969ecf\",\"/knowledge-medium/src/utils/toast.js\":\"17974e1ae37fe6fe\",\"/knowledge-medium/src/utils/toggleStore.js\":\"d048f3046ae36da2\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"da6279144986c06e\",\"/knowledge-medium/src/utils/userActivity.js\":\"5152264914a725c6\",\"/knowledge-medium/src/utils/viewTransition.js\":\"7d5e1918eef5a690\",\"/knowledge-medium/src/utils/viewport.js\":\"bf430e7e1a4a7926\",\"/knowledge-medium/src/utils/webLock.js\":\"4a05b58fbd90f613\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"2018668761475d61\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"e1f6852159875fde\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"f89d2ccb88b0be68\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"955f371bad9b6bd6\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"8d480ac6f4b75e03\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"9102eb0533a6d908\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"dc28a9cc3d8efb1f\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"ec4c683e7bcd37ef\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"e2cc513b01eeb232\",\"/knowledge-medium/src/vendor/react-dom.js\":\"8eec97b39d594e00\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"e70fbed085249c58\",\"/knowledge-medium/src/vendor/react.js\":\"ed49c5e0f7b4f9f9\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
