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
		buildId: "d675942b7075-5fa45ff5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"98504fb8eac6cdfb\",\"/knowledge-medium/index.html\":\"98504fb8eac6cdfb\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-6fvShRZz.js\":\"12c8a6d6e01d7eb4\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"731f5b708f72a699\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-MABOcPv3.js\":\"554d15d6b1045dd7\",\"/knowledge-medium/chunks/FacadeVFS-BipI1y6Y.js\":\"03f32ba13c12b965\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Dq_y5l3F.js\":\"7bd391388375070b\",\"/knowledge-medium/chunks/MemoryVFS-CBkCBjUl.js\":\"cfe630d70749c8de\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-Bb38QuIQ.js\":\"2906ba597ddf1e20\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-_FbYUi4b.js\":\"b03baaff28fdb95c\",\"/knowledge-medium/chunks/Preview-_S0IypO8.js\":\"7bee3ce469ab8767\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DrDDFSDn.js\":\"ea99b97749292bb4\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-wwGkZ2LB.js\":\"3b8bfa5bb81d9b4a\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BlojwOdI.js\":\"06ec1e95027b5e5f\",\"/knowledge-medium/chunks/react-BrazgaSF.js\":\"76f8b24ae2fbcb1c\",\"/knowledge-medium/chunks/react-CnS-HZyO.js\":\"ee0b77f9e5b9deb1\",\"/knowledge-medium/chunks/react-CxGAFcu8.js\":\"3b28c19e452a341e\",\"/knowledge-medium/chunks/react-Cym2c_Oj.js\":\"bcd4609d224b5e68\",\"/knowledge-medium/chunks/react-DELB1BPx.js\":\"d1da2f8553e250be\",\"/knowledge-medium/chunks/react-Da-3jpI2.js\":\"592d922f6de835da\",\"/knowledge-medium/chunks/react-UO5T-KUx.js\":\"a297ffadfeee1ad7\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-LN80L3Uq.js\":\"563d522f587d440d\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CLIU5qWj.js\":\"9f864fad4d79f82c\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DlcSZ7S2.js\":\"381f24ecb7007dda\",\"/knowledge-medium/chunks/server.browser-DO0tohXL.js\":\"3b068ebec547ca83\",\"/knowledge-medium/chunks/textarea-C2Bk6psH.js\":\"fc8c1af6c147cdcb\",\"/knowledge-medium/chunks/ui-OOZUtWhR.js\":\"ca064e71b1f6d19c\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"c17126b38669e78c\",\"/knowledge-medium/src/appUpdate.js\":\"a4f015f4bf057f66\",\"/knowledge-medium/src/appVersion.js\":\"ac8876096d95b67c\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"8409975aa03b7624\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"a597100ba016782e\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"b78a80d8f710aae7\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"6fd5d680a6eff22f\",\"/knowledge-medium/src/components/BlockComponent.js\":\"c3b0771873bfdfcd\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"e5744eadefe2531d\",\"/knowledge-medium/src/components/BlockEditor.js\":\"b0b7ec9bb1041575\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"8033144ce05dd7e2\",\"/knowledge-medium/src/components/BlockProperties.js\":\"004fcbe63c9f878a\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"6581f140fb620964\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"78863209d7125aeb\",\"/knowledge-medium/src/components/DividerHandle.js\":\"13bc9b15282515fb\",\"/knowledge-medium/src/components/DraftEditor.js\":\"df244b3341311573\",\"/knowledge-medium/src/components/GutterPill.js\":\"02b4db59fd612350\",\"/knowledge-medium/src/components/Header.js\":\"60f366e0964c0bda\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"942065b58927ad76\",\"/knowledge-medium/src/components/Login.js\":\"18dcdbf472949e6d\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"e6fbc2f8f5e2da17\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"13a147e8d1166db7\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"16db70693b7d8944\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"810f29f24fe62605\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"54db2480aa830e1e\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"5acaaba60b78b16d\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"db20698a6584d585\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"da940cc9d1bab27b\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"0cf0b92c6e10043b\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"3d82075f0567d224\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"a3d4072e1191e2cf\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"33bb51ef1af2d1aa\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"da6b7a506f159c8b\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"bce0f76d4bb0eacb\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"2d76c7eecbf59df3\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"d4ba31ae4dcf89d3\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"bc684e1f1c8245ad\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"d37ceb0bc7f06dc7\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"4c6d49e2b11a8a9a\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"3b3e1b96f14ad7d3\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"3282199701c547e1\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"4a10df3766834dda\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"486feec94b1bc52c\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"6ee4c06c19b03445\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"092dc60a5b71c4c9\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"0261c58c7ecd48a6\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"2399e221ceb0276c\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"a76f483580a2ceb1\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"6d79643832d39f50\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"e9cf5a1c26af4374\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"52f962deed67f007\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"17a814fd20833b8c\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"37f7e1b7efd71286\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"69a2d3d0fbbfdb55\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"c10106aa543d973e\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"7793b714d845fe03\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"51bd932095492e7b\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"5b6bcde56e071e5f\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"aecbeed631018fa6\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"769fb69720ed7972\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"d0960e12a3d97663\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"dca5f507f15f5d3b\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"b477e937ce241e45\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"cc72fd5a1d73f4be\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"526718477e6e0d95\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"b3d9bf16173567ed\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"9a439eb7ac0f6e1c\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0d4bf4769b10086a\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"ad8e1cd34287f52d\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"12d9ad21a631e4f6\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"580713fdf5f3e97e\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"56ece848d55e048a\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"17ea76d0428f4844\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"d5692e01a382581c\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"aae14691dc6c90ad\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"4a15ac595b17ab61\",\"/knowledge-medium/src/components/ui/button.js\":\"794798f6d85ae312\",\"/knowledge-medium/src/components/ui/card.js\":\"5758103e10dfb295\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"65c9991220d3f377\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"2902aff0fc0fd85a\",\"/knowledge-medium/src/components/ui/command.js\":\"858d7bde3fad803c\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"077340c1df869105\",\"/knowledge-medium/src/components/ui/dialog.js\":\"d5c3cedd7a7fc271\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"3933aba1aae5a396\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"c3dc1e1147e487f5\",\"/knowledge-medium/src/components/ui/index.js\":\"371cc12a59ae7511\",\"/knowledge-medium/src/components/ui/input.js\":\"3aca9653726435b6\",\"/knowledge-medium/src/components/ui/kbd.js\":\"3b2b3d809d818953\",\"/knowledge-medium/src/components/ui/label.js\":\"560a9933b818123f\",\"/knowledge-medium/src/components/ui/textarea.js\":\"9644be235b72d73c\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"7cf233041d8c3914\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"4708489d5ddc8274\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"4810f8d654c68244\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"dccc70dd138f67fa\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"b14735f68ee640b9\",\"/knowledge-medium/src/components/util/error.js\":\"7b4cfd2e8003a7ae\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"b4118b0ddb898cb1\",\"/knowledge-medium/src/components/util/suspense.js\":\"618bfd200db8d01c\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0f5ff92b4c7eb6b1\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"9f58149f51370036\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"6a36d9b5378a3c5a\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"8c0d657151519ab8\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"b2ebce593df5835a\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"e1723603d952d519\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"dc9c4774f9efa203\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"42261c864342475a\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"4bb320a8e30333cb\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"7614498dfc2b9a88\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"8a5caa379cf52b0a\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"8e9596ea4f7bcf53\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ae05c3471ce8a5c8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"e3c825501f88e79b\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"19c56ee609d616e2\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"07bf47cfcc1fbba4\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"363e5306770a0abe\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"57cd16d0f96c8f7c\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"6733be58bb108392\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"037f98d0c1882cbc\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"a0c938a14151be52\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"6b842168bbbc4bc5\",\"/knowledge-medium/src/context/block.js\":\"4969d89a0f479cfe\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"6e5ff1e95329f8a8\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"ca36021d93a65ee2\",\"/knowledge-medium/src/context/repo.js\":\"ac335933d8d02fdc\",\"/knowledge-medium/src/data/aliasClaim.js\":\"3de37d821a0f0902\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"2a49bcb2fc2b5f67\",\"/knowledge-medium/src/data/api/blockData.js\":\"7540f139acce6182\",\"/knowledge-medium/src/data/api/blockType.js\":\"fa19bb3c01ad4f66\",\"/knowledge-medium/src/data/api/changeScope.js\":\"c57835953bbb4c66\",\"/knowledge-medium/src/data/api/codecs.js\":\"b38c29dc3abf128b\",\"/knowledge-medium/src/data/api/derivedData.js\":\"6004787a82618a43\",\"/knowledge-medium/src/data/api/errors.js\":\"04dbf8ad14fa1552\",\"/knowledge-medium/src/data/api/events.js\":\"91824c5a5b3e1a40\",\"/knowledge-medium/src/data/api/handle.js\":\"d59f489ad1e66c77\",\"/knowledge-medium/src/data/api/index.js\":\"59db7094d5a7d306\",\"/knowledge-medium/src/data/api/mutator.js\":\"d403832bc4226506\",\"/knowledge-medium/src/data/api/processor.js\":\"6abec2956e40a47f\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"8ad251b806e174af\",\"/knowledge-medium/src/data/api/query.js\":\"2dbe15390e5f0de2\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"7af392f895aae225\",\"/knowledge-medium/src/data/api/schema.js\":\"d59f489ad1e66c77\",\"/knowledge-medium/src/data/api/tx.js\":\"d59f489ad1e66c77\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"bdd2b994e0a4fb4c\",\"/knowledge-medium/src/data/api/user.js\":\"f2c143abe1266de2\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"bea7dab5186295e5\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"707a129dc097fe30\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"51cf0480fcbfa832\",\"/knowledge-medium/src/data/block.js\":\"e18fbbcb02dc13f7\",\"/knowledge-medium/src/data/blockCache.js\":\"56b50daf08f89e0f\",\"/knowledge-medium/src/data/blockId.js\":\"8d4e6af963d78dcd\",\"/knowledge-medium/src/data/blockLiveness.js\":\"8d8897458332aa06\",\"/knowledge-medium/src/data/blockMerge.js\":\"0956ebe158c0e2b9\",\"/knowledge-medium/src/data/blockSchema.js\":\"0063ac1d86cc3857\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"d44f9138ea2ebaba\",\"/knowledge-medium/src/data/blockTypes.js\":\"772a820899081410\",\"/knowledge-medium/src/data/clientContext.js\":\"259e8e2d8a78a9b3\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"778f9fdc50e89070\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"7762b0ae81013f38\",\"/knowledge-medium/src/data/derivedIds.js\":\"5a30ee37dbdcbf68\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"ca41da2d0b71d1fd\",\"/knowledge-medium/src/data/facetBridge.js\":\"931a18a9c1f0d711\",\"/knowledge-medium/src/data/facets.js\":\"4de7c1dde701a8dc\",\"/knowledge-medium/src/data/globalState.js\":\"e4b41c7f606bc9d0\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"ada272171ba6374d\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"30587b0d69a3299d\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"0d9ab852a525e0ad\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"21942e59738abe8f\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"614be4c4df4cd473\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"f556e16b727c4b2c\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"035e4e121c8ae781\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"da25594f36581a54\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"07b139c2fa94dddd\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"c69cf4c26d1dec04\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"6c1f484a351efed9\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"2b3c5cfacb040e45\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"eaa6083b1d57a50a\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"8a3a400432d7a61a\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"f264b75af2bd5f4e\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"8f189a68908c2650\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"7a590afef42c3165\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"a93f0578f3fd62eb\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"d0d52fc6b6f6eb2e\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"334a2b4e50a3748e\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"bd4f10a83b86cac3\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"6bb61c17fac10240\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"4a1428192c3b8ad2\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"b7c9a74f07f33812\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"108660fe508c971f\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"8503f824f1566bec\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"55e5085a0c672ad6\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"f02850a66bf71631\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"0a544802fc8590ad\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"a0115b0c1bd6e540\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"1e0d5aa44e94abed\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"339ad07445452e0e\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"2f59d80b09f512fd\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"2b476f54b133b704\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"589064b675d570c5\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"1160f92ccc2ea759\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"26e34600401f8c8a\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"717af5593524b459\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"bf5b8e292a220059\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"a87aa14007b4a56f\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"5541f2ea4e0738d8\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"81e5526cdb4f5424\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"01b60aecf9ca5357\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"9c171a67af8b2765\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"fe512789000029a1\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"fb87c3d54613df44\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"ddb4812cd29f9616\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"671ac3176d8db545\",\"/knowledge-medium/src/data/invalidation.js\":\"ef3490f55014959d\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"ce9dbfa0d29a0b02\",\"/knowledge-medium/src/data/kernelPage.js\":\"68d84c169895d0bc\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"cab350eefe756c9e\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"a860d458196fa584\",\"/knowledge-medium/src/data/localDbStorage.js\":\"0a95f17f907c12b4\",\"/knowledge-medium/src/data/localDbVfs.js\":\"5cd1b28d3aca3c26\",\"/knowledge-medium/src/data/localSchema.js\":\"e3276c63c51958b0\",\"/knowledge-medium/src/data/maintenance.js\":\"e7f83a8f9a44ee4a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"ac87815d9d7b7f60\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"50134e1b3050cab7\",\"/knowledge-medium/src/data/migrationsPage.js\":\"84d87b98e97e488a\",\"/knowledge-medium/src/data/mutators.js\":\"5cc538b29c8c0d0e\",\"/knowledge-medium/src/data/orderKey.js\":\"54791a0767347a39\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"c71fe54941b0bf94\",\"/knowledge-medium/src/data/outlineSurface.js\":\"d0026d1a87e8d506\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"774d49a4d92dd553\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"eb1ab0396624001d\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"5a47f25bf24531e4\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"25c0c7d95d792f4a\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"d08fb6576ea6dc5c\",\"/knowledge-medium/src/data/properties.js\":\"4c36e86d9e366558\",\"/knowledge-medium/src/data/propertiesPage.js\":\"3702d95aea327005\",\"/knowledge-medium/src/data/propertyChildren.js\":\"832ecb89cad08ed3\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"28cb3d1a8a7e9f31\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"fc6ba15efd5bc86d\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"b8348374f7f74731\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"7aa39ab7a7a2407a\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"8c53c09b7492d972\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"3daa8bb626620d5b\",\"/knowledge-medium/src/data/propertySeeds.js\":\"8e300b055f1ec6ef\",\"/knowledge-medium/src/data/recentsPage.js\":\"ea7b58864afe187f\",\"/knowledge-medium/src/data/referenceBlock.js\":\"c5c6f32e77dd32d7\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"bfbcf5b9187c6be7\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"28635cc7994845ba\",\"/knowledge-medium/src/data/repo.js\":\"5b7958e76d4206d4\",\"/knowledge-medium/src/data/repoProvider.js\":\"0ab7c615c461a9be\",\"/knowledge-medium/src/data/rowProperty.js\":\"d7912480d411bcb7\",\"/knowledge-medium/src/data/searchFilter.js\":\"31138dd5e5850dc5\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"ffa40908dc7d37f3\",\"/knowledge-medium/src/data/stateBlocks.js\":\"3f38bfb0509bb597\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"ff47f444d13a332b\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"025e937ae5ed2bf5\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"060548b351168b9a\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"33e408cb301444f3\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"a6f595925d6cb3f4\",\"/knowledge-medium/src/data/targets.js\":\"284ce7ff4d0c9e58\",\"/knowledge-medium/src/data/typeColors.js\":\"c453b858ca3f61e6\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"0a75d8531169b326\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"11dc131beb420fbf\",\"/knowledge-medium/src/data/typeExtraction.js\":\"8f4c27f125b4ef85\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"94dbce32b698a7b9\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"c2a4e00ffa645abe\",\"/knowledge-medium/src/data/typeSeeds.js\":\"8f4325c5fb1a9f8a\",\"/knowledge-medium/src/data/typeTagger.js\":\"1e6e6a3d6833756d\",\"/knowledge-medium/src/data/typedRecords.js\":\"ee8358f39dd3cab2\",\"/knowledge-medium/src/data/typesPage.js\":\"03ed804da47efe12\",\"/knowledge-medium/src/data/userPrefs.js\":\"daca51703ce2f67c\",\"/knowledge-medium/src/data/userSchemasService.js\":\"7e4080a553806d3c\",\"/knowledge-medium/src/data/userTypesService.js\":\"224bd57080c1798d\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"bf1243791d09d5bd\",\"/knowledge-medium/src/data/visibleChildren.js\":\"56b82680ad856a6a\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"27066eabb5ee81c2\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"56569b8ac032f384\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"7ec0134ac0e4130e\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"f79761430f903329\",\"/knowledge-medium/src/data/workspaces.js\":\"902e0c4793a5a910\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"582a01256e06da8c\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"320d92afd249d89a\",\"/knowledge-medium/src/editor/atTrigger.js\":\"e9e9aee721875370\",\"/knowledge-medium/src/editor/autocomplete.js\":\"e6c9308581d2ae94\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"a6aab76687634959\",\"/knowledge-medium/src/editor/contentFlush.js\":\"e671212b234ef41c\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"507e365e39710eae\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"78111cc69e97f1b9\",\"/knowledge-medium/src/editor/insertImage.js\":\"d999a8053af6a13f\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"8e957644ceac0408\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"04dc30bbfff2a0b7\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"343bdec37fb6a072\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"a85eabeca6170c66\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"e287f12e8e68f46d\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"1e8f9b45abf17340\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"c22f96cfe24c2b4b\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"d8dd0315db28d246\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"a3e107f152a9b771\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"8a1f18dc8c957da3\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"34685a2f044f3c90\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"b00b83a1e17788a9\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"ca42c2d429288616\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"996e6d2abd7238c9\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"136c6faff35eb9c7\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"e7e4aad31d22951f\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"c5df9e6f27e30154\",\"/knowledge-medium/src/extensions/core.js\":\"d77f938c810847c7\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"3c70433ba2ffbdc2\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"dec810e1e2231214\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"aa0e98df7cea8592\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"e6e0ce1272e918f3\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"a8ecb85606ed2d13\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"5f527facf6660637\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"ae33fa31ff514f81\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"72f629067e5626fc\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"eb96e18237c1f16d\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"de732e44d0f727f7\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"0db532672c0a6da9\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"fe3898cf7eec254f\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"72f13d3b6e397461\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"ba4cc4c4462e0434\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"fce6b8d127c25a19\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"ce3774fc4476b95f\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"6e19bfb851e92132\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"a4b6f81788f332ad\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"ae5d8a53eb97f679\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"190511eb7518a599\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"7d2f0802fad99680\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"ac094c3fe3b5cc81\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"6e69ce0f646a4df9\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"dd33fb227f14d406\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"c1fe79e43d68e33a\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"ced25c6abdeb3a03\",\"/knowledge-medium/src/facets/facet.js\":\"c9c2abc5e57aaa24\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"8df2d4c873ac063a\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"0fc0ae65fb8ef72d\",\"/knowledge-medium/src/facets/togglable.js\":\"e6d58e53bf0e5242\",\"/knowledge-medium/src/facets/variantFacet.js\":\"74943a9c3dff083d\",\"/knowledge-medium/src/facets/verbFacet.js\":\"6f517ef3304ed80a\",\"/knowledge-medium/src/hooks/block.js\":\"fae5fc8bcbebcca4\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"0a3ff2809eabc599\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"819a8025ab676384\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"548e8570d4048f40\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"e439dfbcdba6a6a3\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"6391c656a13ca976\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"257a5a4e39a095b4\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"ffd560a76f46e475\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"cddb95ef70a99900\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"4eae107b604aab8c\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"5b0f75e8e6ff5bd0\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"a979a12bc2c0e30f\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"a7e64f84163d98c3\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"ab9a011cede0df08\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"6de1be0e1226cbbe\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"534ffa9066b49f54\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"10219421bbe7aed2\",\"/knowledge-medium/src/lib/utils.js\":\"c6bb4f24109f80f5\",\"/knowledge-medium/src/main.js\":\"f28d5d49e5a8d496\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"71f2dc90bf9d208c\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"9ca53240254637b6\",\"/knowledge-medium/src/markdown/context.js\":\"a976af17b8712510\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"3ccb4664db34c2c0\",\"/knowledge-medium/src/markdown/extensions.js\":\"ccbce914e9543257\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"2e8238177a8da63d\",\"/knowledge-medium/src/minimal-editor.js\":\"0295f572b1d6dead\",\"/knowledge-medium/src/paste/armedCut.js\":\"840e8a48a04a2606\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"8dbe40e5232e2d3f\",\"/knowledge-medium/src/paste/clipboard.js\":\"808c784af0f18e67\",\"/knowledge-medium/src/paste/decision.js\":\"cbade86a8e4d67d4\",\"/knowledge-medium/src/paste/operations.js\":\"c7a93bab4a2e1ee1\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"75ac3a6880d418fa\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"63d6a02850824ea6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5b57b20c9746dda1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"95bb393a50f85a04\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"428a0bb3b6073de8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1b475518e8fa619f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"cd497de502d8f4a3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"308e8f21fcaa8de7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"c1df52a99281467e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e55c37e95064c806\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"51a0641f5b6699ed\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ef218911c7060558\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"91c930b32b4f9b17\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"342be76a7f5cfc96\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6ae92e110b3283c4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"5665a92946d0fde9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"b8e73b206142977a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"27ba5e085b02918d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"d025541e26890089\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"2909ab0404c30fad\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"8ff9b62d9aadd8d2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"a4d6b534cd7f81a2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2daaf0cdb94be6da\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"09173b5e6fedb1d5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"ca84d848fc342cd6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e3362a7d6287fffc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"8faff0cfe1b7b4e0\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"516b021dd2ac0836\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"02cd693be5bdcce9\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"c27ad2a525f4cf5a\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"8477d6c1238a552a\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"d1f53c05bb21d994\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"6eb2dae5a405eef9\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"bc8e0cd1b0b49f64\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"3539bd0b9ce26e0f\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"7c5131601aa37c07\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"56deb2a7caf39bfd\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"c139ddafaaa31f10\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"5554d56a4ceaa853\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"bd1e5939c6c9be40\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"f0af65c5dd48b094\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"ebac3a90e793dfdb\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"e9fd0a1966d3763e\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"eb795e897a5815a8\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"bf7c6c09495f40ce\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"abd3e0f48e7601ee\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"00d5e528db9e164d\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"b0efd4e4ac590e60\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"7b4feb40f1455aad\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"471ce582eba858cd\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"882789e7ac5eaf1d\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"d871ce2a4fa1c9a8\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"49e543174d761409\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"d13415b12a0c8bb2\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"c260052211504c7a\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"4eba67d782fa8183\",\"/knowledge-medium/src/plugins/alias/index.js\":\"8b56b82d7d58d5e1\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"24bc2e9fabb1ed5c\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"22f8b35762a8191a\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"6ae639c90b52dc7b\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"15c2ab1acf31e43e\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"42d6cc6d5a89adba\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"1bf03d06e034802c\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"934f9718639bd40f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"0f3256c13dcd14ff\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"1899a39a57ce7dd2\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"34f1efbab09d8da7\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"40b24236952e8556\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"1e1208a55eeaf82e\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"7999eefc5dc0d4ee\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"1f1e0568d79d8698\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"751e720803101906\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"0d3922ef0d2563a5\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"129daec702869b34\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"0cbc7e52a733b631\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"5f1815cdf3e28c2c\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"bc1fa7bb939837f6\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"f5d42615a2c13a17\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4688f24f98e8b32f\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"9124bcef9fa76be1\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"dc996334c17ff1a2\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"f5c0d729a2bef145\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"48286849da234ca0\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"79b004c2dcb946fd\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"0c08f42c6c8d1ecb\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"0c1ab610fb4eb5e0\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"ac866eebae9986f2\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"7b346b02a0c0419e\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"7d6be7918917f731\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"f6fd9ab7f3d6aa6d\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"83922753f2057f3b\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"b57b47810a46bc66\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"d347c73b3070efbd\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"43f87a2f7640a618\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"3fcf2eef8dcd116f\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"f75a7c499a162adc\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"747dafe9bdcd3585\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"f4c13135f209aaf0\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"48c71f4caf119e0d\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"483fcee4d6abc318\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"9b45da805674a4c5\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"918ae7a6a0679a51\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"5a5848383890a6a2\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"1710169cd254ae75\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3c6ec3a771d670ce\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"617c30882029b4aa\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"338921b646af0792\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"e2a264a2450eb6a8\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"f78c362e2e16f668\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"c8ba06b3c9a2adff\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"6cc70454b84f6dc0\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"5dcc6953a218ed47\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f8420a8f82370985\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"80401d3c51034342\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"d95b2104c5e707e7\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"07bc680187a8ccd7\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"d90e740ecf0d3178\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"cade32cb335e2c18\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"e1025460ee51dba1\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"6e901040adf65a34\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"4c9c89438857e415\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"057161a24d1952a5\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"6e08afe64fa6e382\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"07f83d8529f7c009\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"04fe136c280b3b77\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"e16d407db53b6134\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"3c8f2e204cbce293\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"0312a99835deee0d\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"d246d32b843e5c11\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"de4a7a88c6ba356c\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"9eab47e12616d7d7\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"e9c29b53a763f71b\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"670043626b797dad\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"4600acbdcf4d9603\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"2a271dd68f74c2d4\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"761e2debb77e390a\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"8e5c69158de59e05\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8d9a53474ad2888f\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fcbc6f54c0dedb2e\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8b9b9ca4ab82c71c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"27d50cf671bf54c5\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"a13ed1ce43580f22\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"5e277cd10aa6c50c\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6f51a237db23e72e\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"e297ca8857eaee1a\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"c4c7d66f74e552a2\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"16e3abbbd12388ff\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"44d186475f2168fc\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"0056c355fa1c0a9e\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"c329ccf1c56fcb68\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"91f4fc02a3736697\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"842bc18d3e4529bb\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"40db36d9745d2f7f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"220a39d50abc2ea4\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"ff3fee525f00dfeb\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5a5280bd92a01378\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"c13de99b899a39aa\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5e21347eea22b03d\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"97cdedcaee8872f3\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"75b7b942b8c5efc8\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"a2f50383b4f498d0\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"3440536d98e48f95\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"0a335abc306aea5c\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"b8692323a043f6a2\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"2b6af3a56e1c4967\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"449d4a996cb703f4\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"96aee10a2ca31a6e\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"4056a26dd6ebf1eb\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"ecccdacd68b437e8\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"382e3165a6800b70\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"fb810f4d39da49d5\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"0973f0e53c81a981\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"25760f2edd279799\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"c5c5c0fab056939a\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"5cb02375f513dba0\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"ec6aad2cc3c23724\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"0e66946d47cdeead\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"be99fd1cb696bc44\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"17bceac7a5cd2936\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"08afeb3efd565876\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b4fca334c0595694\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"1dafa77b6ccadca4\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"528415c989e01c08\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"a5eb2f07e7a5921f\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"fd616ed4f4ba8efe\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"3796548ad0dc15a2\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"9e37b7f150208a2e\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"d57cfa03168b703a\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6fe90204150cca03\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d6a091504d714f30\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"db93b918b7b882cb\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2b3f245afb9bb98f\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8718a13f281b3976\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"7333cd441d0438f3\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"dad1078f061947ae\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"86ce00fef8edd460\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"8345a86ec0b326b9\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"f06c9abbeccb08f4\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"d9e6d3659e1deaca\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"406de0166ce760b1\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"e5378013be5c8447\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"9a1d9a59fa6ba966\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"6ad787fdf488e138\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"9cb0713e30529e2e\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"c7348b41dfb19584\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f9916789e4d9ba60\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"37a344815639c3cc\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"172922f5acc78717\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"842cfd5e6ec1a877\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"ac4c210ccb2a2e32\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"b97522a380cf96e1\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"61bfc46a076fbd35\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"51aa97e8de1b1c71\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"5d2957ed49177b53\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"9c8854bbd6973ff5\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"65a825874ab82661\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"daedf966f975fc19\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"b6637b1da48ca79c\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"f74b2a70b4e0670e\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"bb6142e65c34b82e\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"d47c6fe1e34a505b\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"bdb7f0816484e191\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"0edb1c62eee9c7d9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a53cfeb53b40517e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f2129405b453d5e7\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"2257fe42fa970b23\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f17795ac9568649d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f1020e255b4712be\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"fd1a2bbf587b8643\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"fe89aef23c3ea4b1\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"19fda6b4588eecbd\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"10b1c3d156510a0b\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"ca1e91578c51c642\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"42b2f1718d82fe9e\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"207fbe2d3c3c176c\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bfaa6136bbc2bf69\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"0327f2e53dee8ada\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"44480b184ce42046\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"f2c3281e10fbd17a\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"31637ce9e318d43e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"3bf72ef741d47713\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"891b6880771228b1\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"f0e2b328b4ed7865\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"22efff947f7180d9\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"08fc9e17e80cd4a1\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"3e123820964d3bb9\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"c5ad960a2e61946c\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"16e86190d637b4a4\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"8117acc41cf8ea09\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"a41783221716a09a\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"5cbdc6c29c15e0d7\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"9d74398cdaa4bad3\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"11846cefac2f5370\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"b57e9dfaa35bfb7c\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"52ace1608ab04708\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"3f2b07502b554640\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c29e37458f037acb\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f7fd4a90b4d2401f\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"859cacdbf8ab60d4\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"536d8adca8e87b46\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"d1b6640eb6b16639\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"a90a22eac29cb7a7\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"4868647855aec45e\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"d28813d34d7bf309\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0121ff51ca4c8890\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"1127a0196f5c7646\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"6b0b8ae480cf9206\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"14053b4ac0c18d5e\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"8175d00dc9581e74\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"aed2e05e7cebbf8d\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"8470d81c7cabebf9\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"8dcb4a17e467f618\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"50d4e77987276900\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"867cdae61d978f1e\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b0e66a9f6adc9369\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"c4efbb8e674b9676\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"a8945652c21f6283\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"c22b85f0ff7c54ad\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"c093f7d8d58f30dc\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"311f68ded592fe0f\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"8540321b2c33b721\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"c399a0b6e0a656ff\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"c317ebe4dcaa88bc\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"0955cdc80d76cbde\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"06e577a21f81f08e\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"3684e835b05d0737\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"c018daff4f78a30f\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"9d24e93aaf8e86d8\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"67c64cc5cdf69d3e\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"5ea398c55a06dc9c\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"c5ec7e475850dd97\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"ac87c9d5ed545c9f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e09982e23d8bb777\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"867f106d3a64bcd7\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"09e7c8b974d80b9a\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"84f3742ba4dd1565\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"9754301b5fc58de7\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"f35e40778c33d3c6\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"062663573f842eb6\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"35c936487400da79\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"5eb43de2107620b0\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"df3f863e0c1554f9\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"49cac268d282685a\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"e50bbd574701117e\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"c5aefdbb51076f34\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"23ecf99ab513a44b\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"b6d9a9365f12fe52\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"7f44527abac96b21\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"caa84db174f75653\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"df7d6e6b971f32e3\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"52e95c22eacccbb0\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"f77b6a75ce518f86\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"5d55870823649541\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"f17802dc6b531675\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"cd30590e115fbd12\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"b8cd21382a0824b4\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"a33a6400dc338b31\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"9f58ca0d18e3fab8\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"3002e387e969995f\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"5865fa524eb3c1db\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"3a4315c6517c0172\",\"/knowledge-medium/src/plugins/geo/index.js\":\"18ec5ed952da555b\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"6315d11da116aa7c\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"d937eb5d142b923d\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"d236ba3f81562def\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"10299222f8fdfe88\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"230a27b54b856283\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"0bc1f3f3c77847af\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"d4ca4ec46b77c9c3\",\"/knowledge-medium/src/plugins/geo/query.js\":\"724bab47f31f603b\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"e6d76d4c0d279bc5\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4b1977cfcf6c9641\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3eb692e70d7037ec\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7d05d460dd7851c6\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"bd2cd1fa164d1bf5\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"d40dc2ac4663580c\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f6898ce701917fe6\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"fdc8f083e718c6ad\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"092e9e9ce6ad074a\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d02db349f1b4cd03\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"5505a623c2139bc7\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"984e71dd73f6b639\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fc23bb941ba90065\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"52bec3418dc1d8ac\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"12f607b7789ff007\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"a991b3823c490b42\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"96a81c92dbc594e9\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"49457427f7925b30\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"a636e54bf2aaf6a3\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"869c25beb298743a\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"5d434a9eb0be8662\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"22bac967731b3708\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"2cf5c1db8a70d86a\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"c8a353298aff7e7d\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"201247f3a3f23b22\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"2297029ca6e7f663\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"37aec21069ea3a5f\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"557feba42128ac1c\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"13682ed5209ed047\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"597d9a5107f4b1f5\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"459b0e29d1ebea08\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"a92c167e50f5e22c\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"285a33d1ed0e4295\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"54e0dd1d054c1609\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"086afcd503bf04e9\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"5a94daf2c800e1f9\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"dbdf3cb68b78e4cd\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"897d1b68b617ac30\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"330e1576cc1158bf\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"614d683134f41c65\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"50b2982b958469c7\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"4e6fb4672e801f76\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"88c2aba14b86e583\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"fd9820205a87de35\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"fb1ac25c6e4689ef\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"216f7b06d42c9d76\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"9a02c132bf3f4e80\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"50f7aa245a15630f\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"65caf6f9f621d9f6\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"9706abfe0cc250c3\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"2238e198cec805c4\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"a01e1dd94339930c\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"448f6462c1fa3844\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"57667fd8d05d6ef8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"b1d0a07e1d62afc8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0143b30aa6f401ce\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3441d6ea534a0dff\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"2f5df45273f59e9a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"53af248bff8a0bb2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ca42f3b9050efd0c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"712e496ac3ea6b2c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"194eb74aa7fbcd4b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"687700a023117c46\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"41cca2a2c4918019\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e4c35571b2ca1f48\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c49a11058cc6858d\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"1478132a7c89a199\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"1b8215c0ecfa8793\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"65d46f19233562dc\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"0f5e6bd7fb4ccb0c\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"96f5acf56d33f015\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"7b6b8314279e6b9d\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"7dc9c1e4aabd44b0\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"42d05802edca0932\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"ee1e3444b9dcca5e\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"d2267f8fa48e031c\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"3f4e3e51a2291324\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"635a5ff38a091282\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"90e92998219a7244\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"5acd88c7135d0833\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0d0cd2b30d8bd836\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"efbcc14e41f4a3a4\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"020853b446cdbe06\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"1f518d028efe97de\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"a8e7e3ebe2977e6d\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"1413fbc19da9b6ca\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"7c78de62fa223efc\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"6a26d0907335ebf3\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"fc2558786eeb62f4\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"1ab4860b86084abd\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"f12caedff3507e88\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"f4992ea3dd1d1a8e\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"8b2ec8b8e8002f87\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"2e42a5394e644545\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ca44a052f02128f0\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"7fefb8bdb2ffb19e\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"a070088969af8a71\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"4f82ee7129f83a85\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"2dbfd79ca3a2be56\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"602e7bf8c3d268d7\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"2b9e22adc6207810\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"56f871c47dee1d5e\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"cc0dbe9517f06e82\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"e194473be557382b\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"9a35ce1804965fe0\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"59ecb0a854de197a\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"515a45575cccc8a1\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"72a652e2633829e0\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"168062c1d0c24244\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"c0cf6b8b63bae43c\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"17dfd15065aed712\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"6b46d5999535490b\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"aa0f42f4c33d7628\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"7b749fa019847133\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"4b2a7b6c32c8b2b8\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"2f57fa5f6817bc4d\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"477f4af98835de85\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"8169ccd832aeab29\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"18542f2563684293\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"894704d4131b5306\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0af5f34f96855635\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"9bc9e830dacbfa54\",\"/knowledge-medium/src/plugins/recents/index.js\":\"9de3c71667b171cc\",\"/knowledge-medium/src/plugins/recents/target.js\":\"1c54d327e83fbaf5\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"7f82423cd4ddeebb\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"04799ea434f14521\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"830d4d19baebbe42\",\"/knowledge-medium/src/plugins/references/index.js\":\"95e21ad12e36a78b\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"060295c20072e9dd\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"a370cba39478ec01\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"b82f5138fa66d424\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"1a8821c3324307e2\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"59f71f3c8f3bb16f\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"8a64a4107afb08d8\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"0bc1d9a2902db15a\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"eac4cf4a465baa2d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"eb4a52e4cbb1edeb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"e3d753e15c58bb03\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"05d2751487039890\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fdd5539f292e6295\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"9feb15d2989a9b8a\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"41b541c462ee621b\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"54062d07805ad91a\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"8a4a11bdb3716144\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"bdd3d113ebe38819\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"14b6cb5a0218574c\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"8ec340c89ca9ed3e\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"a61cb2b8433a0f39\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"a727a83471946de7\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f5aac7d6c9bc2af5\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"150eeaf2312142bd\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"70e806ba6a422020\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"0c5d241d155260f6\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"055a209175cb4a60\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"0adbdb445708746a\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"4507be1dd82e397c\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"5933d779c4db127a\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"b4e0c5e070fcff70\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"9964be8edf16edf6\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"a787c1c6864aec72\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"26707bd2d58c03e2\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"2e465e937e442d25\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"6fdb49d3c86503bf\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"aabdae816abac28e\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"92718d7a9e54274c\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"ce1345fd35d6a689\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"927c6fae0f01e9b3\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"a661f08e2de648f8\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"82187be26c10e214\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"dd0171d423095f21\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"d5ee307461277307\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"aa2de453ba8532b7\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"ecbd02aa105ea14c\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"0031f2541a55b771\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2eb5a207ed2d2f7a\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"c734bfbaa7f990b2\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"00339bf7c8a3a228\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"045eabb431a5f769\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"6454b61ec10652f6\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"56d4f3ff5b22e0ef\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"c019d95ea081b69c\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"b2a2183909ca128f\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"630147c4a6f6c5f5\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"a7d57a11bbdde655\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"c64d2882b6c7f0c6\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"d5e5eda89850164e\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"5e3ad5bf689fff6c\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8dad57c91b985878\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"e58b6023acc789d3\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"9f28042d23c8cd14\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"144768649838f3e6\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"c34ae1bb01ae97c6\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a16c90b28d213f9e\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"c99ca6a135e343d3\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"0b8dd4ee53b82da4\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0f5ae8b90637d085\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"cbe9547d7b62bac9\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a3e63edd5836d3a9\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7609fcf1f532baeb\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"c52f0defcfc8a73a\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"fdad0a8885c10a97\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"72043c3fb76edb88\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"1643ddba8d7a1638\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"72138e6039a7f851\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"aa3de9f20e763b64\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"4a2e3ea599f0c832\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"897d9ded1f7bbec4\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"11bf124244252449\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"5fc84014db85239d\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"ff13479daa32d3a4\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"eae649d79c5cc3a0\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"b8cb5dd036181c49\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"1ff6bf016f530960\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"2e451c4f2e9a4e48\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"8edf5485f3f3f851\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"a4c6c4dfeb986d28\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"799fcfdbe04ae7e4\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"f6b8283d32e7dfff\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"cd053785d2369042\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"5c46d8f9072f544d\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"2d480eea92af5a30\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"13c17bc7d9eb482d\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"214e8a8f7f58fbc4\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"b5f54dfb940ffda9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"474ff69562647dd0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"f8962e8759a1624c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"b1444ab4a84a41d5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"cefc06cbf62b724f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"7565582a54f0953a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"47d476eec850af1d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"02b96a09cbcb5bfd\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"926571417bb4be34\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"e4f3deb2b29e60dd\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"a614c43c33c760e1\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"49a793537c3b32f0\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7448d4364a0bd016\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"fdc673afcdf62aed\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"6836e3938540b7c5\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"7287570865e81dc5\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"2f904f8aefe1299f\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"9808645fc6828dcc\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"17fbea9553d6fe24\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"249104b30a7731b2\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"36c5b313e30c0b8f\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"3e6e19d52a2a7a1a\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"81e1800b0378f275\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"37287ba0e0feea25\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"2bf9afd129d0f273\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"df0391b265360f71\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"f358753d66d8e6b8\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"e42c50371a8f0e04\",\"/knowledge-medium/src/plugins/tables/index.js\":\"bffe4db5d0c0d781\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"41417a01ad24e4d0\",\"/knowledge-medium/src/plugins/tables/model.js\":\"baf10ebd6c3a6c08\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"d5067661b058e00e\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"83835f66bede4be2\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"1a973654b8e1e254\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"a8b6fa9cac051f7b\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"9a7583238796c31a\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"775f4d7c7640b762\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"27f3a6433f909553\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"174cec54271a53c6\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"dde9f4cf611b54a4\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"b366660472652828\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"dbee529cbc94cd69\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"57c54f4f6cf4f762\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"34e984025f84e2ca\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"4d48f4c4f966eab0\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"b25d337226933677\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"88f99c94c13a711f\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"66304c14221c2f8f\",\"/knowledge-medium/src/plugins/todo/index.js\":\"203e3e1832626cc5\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"7af2559a09eddceb\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"73f52ac8dd2bc1ba\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"39a124a6cc627f24\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"8aefb8788c8265f1\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"f6f039b4bd84d36d\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"0aa5764700e8db64\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"612b79f9ea2c2fd2\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"a3138b151c85530a\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"25abd576c43921e8\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"6f8561a3069b4de7\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"8b49879b6747c346\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a873a935356399be\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"f7a7ce972dc0b0ef\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"64b93b5f93315c39\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"35c62919e429caee\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"2be7b90455528bb7\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"6e1d98b918810762\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"a1eafd95427fb55b\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"55f15fa4cde480a5\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"725c6ae7e06ae684\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"930e32c0c3ce555d\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"f335155019cc9957\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"e59626945b12c67f\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"99b04cdca74d5c4b\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"628db2bccde5c242\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"20d36bc7163e2ed1\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"41c9db03e2ce9fd4\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"dc83c8ee089e95f3\",\"/knowledge-medium/src/registerServiceWorker.js\":\"a0441198bb4a95aa\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"6317484d5bfcf5ee\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"bf08620fdd753528\",\"/knowledge-medium/src/services/authStorage.js\":\"1e2287153468ec74\",\"/knowledge-medium/src/services/powersync.js\":\"0adbef68a8065787\",\"/knowledge-medium/src/services/supabase.js\":\"a743a193a48888ae\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"b490939824604b37\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"a52edd70e609939a\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"9a626079c509c9f7\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"89390b5961d7028a\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"aa334706cdd6e6c1\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"6c88145d67a8bf5f\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"908251b59e386a44\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"d75a0c908683a141\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"be0c4abc94bec43b\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"2af0e9959f262383\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"e5291fdd3d7f9288\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"439df001d3de9334\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"b2194cf3711fbfae\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"eef5a70f0dbb9bea\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"ac47cb9897866a27\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"bdebbc07da122c3f\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"b81de038f653afd5\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"e7971a680e4dabbf\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"12d288eb28c5dce8\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"459c0f6bcf6dcac8\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"b2f5bd0ed15cbe32\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"74315c05b1b4be4c\",\"/knowledge-medium/src/shortcuts/types.js\":\"3040feb9928c31d6\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"5ea37fbea68dea2b\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"55925eeee1633e05\",\"/knowledge-medium/src/shortcuts/utils.js\":\"70bf6a307b4ebd0f\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"1ff38130ef65fcb5\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"bc4363b3769b13cf\",\"/knowledge-medium/src/sync/byteTransform.js\":\"857c1ab9eb086376\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"c32534f6f40ab3df\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"9d155e98413ec04b\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"bb855c9a901fa14e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"3d0ef9964c8f4fa3\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"890cd433116ae979\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"fcf781e1bcd4ba99\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"350ff1a058de8aeb\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"66c446b424ce8759\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"cf9992e4c9a3596e\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"1b6167f1fee9007a\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"3b8386991ea3b537\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"f4f5ef6fee1bf85d\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"75dc413d2e083630\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"2dccfdaecdf9d228\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"b964384c1f48a0ae\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"e77324f7d0f2049e\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"2772842dfaa39210\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"b935f65a7cf357ac\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"c9c33177ef8fd556\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"78aa0eff966698d7\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"d69ccb6f99e17378\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"9d1af5bcbaa1256b\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"5dc94c148ea7940e\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"f0d84f8467e871c5\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"ef25258bcc75dea6\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"4721c504d9c87d19\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"3e848a4a8c01d624\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"fb400917e9f084ab\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"53eb793eef5d475e\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"d15bf4a9882321c5\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"5f40dfb2e9b954ff\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"d9f5c3207c5db9a7\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"4676f131bb68af1f\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"e7a43b4f53753967\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"31ccad76e7b244db\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"9ad0161de7a1c291\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5aac7f9298e8c51b\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"949ac5fe350be8d8\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c190d6f93bb5242b\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2e5932285d3dff9c\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"f25084e64115a9ff\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"a0028984cbb2f0ca\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"76abec4049a11008\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"d3bd18e8d634d968\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"f6e4b28eb11d333b\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"a7234474b57f2675\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"53883e9533aaddbd\",\"/knowledge-medium/src/sync/transform.js\":\"6dbc3a2461cc48b3\",\"/knowledge-medium/src/themeBootDefaults.js\":\"1fcaebc7fb41d6b1\",\"/knowledge-medium/src/types.js\":\"b04635a14d58db1a\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"a6cd92a4c39c4a9c\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"6cf881a83117d692\",\"/knowledge-medium/src/utils/array.js\":\"0a84ffeefebb91cd\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"7bd9f1852d2c5474\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"b7110951b77ab7ee\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"8e6c1014c386d4b3\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"2c495e00d4d3c22f\",\"/knowledge-medium/src/utils/callbackSet.js\":\"fd87eb4dbb85b32e\",\"/knowledge-medium/src/utils/clientId.js\":\"b32aeb7dcfd7ce22\",\"/knowledge-medium/src/utils/codemirror.js\":\"681208eff5b5f915\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"6e64eb81a2f759da\",\"/knowledge-medium/src/utils/copy.js\":\"3aa705682c78d2fb\",\"/knowledge-medium/src/utils/dailyPage.js\":\"e76639aa1824bd9f\",\"/knowledge-medium/src/utils/dbForensics.js\":\"a50d44678c3407cc\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a6824ab4ed3f1ce4\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"6ab1302c34f7dc13\",\"/knowledge-medium/src/utils/dialogs.js\":\"7aaaee4056f67777\",\"/knowledge-medium/src/utils/dom.js\":\"bc091c84ce42d92f\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"b3ae7ea58877fbfb\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"680427c50fdbc3f2\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"f5d9b1e663aed9bd\",\"/knowledge-medium/src/utils/flipSlide.js\":\"2508791dfc72e8b2\",\"/knowledge-medium/src/utils/fnv1a.js\":\"a1e5a80e34b7cbf0\",\"/knowledge-medium/src/utils/formatBytes.js\":\"17058d7113d2d164\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"2793d488d3d59f2d\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"486f48e518466c16\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"b1d513b52038e8a6\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"f99bda2fa96661cb\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"173ef3196c544a62\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"c1c38b48bcee6904\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"d7875b58bc0d9ee0\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"843955f5f9f405f0\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"29bfb294132cf474\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"95ec097eaf395ae3\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"9b655825e25b6e75\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"9d5f7d4f32779808\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"8be5a629ee2f48a5\",\"/knowledge-medium/src/utils/markdownParser.js\":\"5d3b6fea4cd6e297\",\"/knowledge-medium/src/utils/memoize.js\":\"83ff7a45f3096c4c\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"f72238150961a191\",\"/knowledge-medium/src/utils/nameList.js\":\"b6cd353a588d6bbe\",\"/knowledge-medium/src/utils/navigation.js\":\"3de533730a0cea02\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"fed921843ff33b06\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"495d2841feeb7e65\",\"/knowledge-medium/src/utils/panelClearance.js\":\"43decbac2d84cb9b\",\"/knowledge-medium/src/utils/panelHistory.js\":\"d3e83165f2f94848\",\"/knowledge-medium/src/utils/panelLanes.js\":\"4f6a52ffd1434135\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"1daccce0a4442050\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"f90e5f19c7f846ea\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"99a130ff8cb5d452\",\"/knowledge-medium/src/utils/platform.js\":\"f5b8cf41cb4229e8\",\"/knowledge-medium/src/utils/pluralize.js\":\"a78940d585b9c80a\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"7aba52a757d6ff66\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"6a6b4235461171f8\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"0a490e0e9129bcda\",\"/knowledge-medium/src/utils/react.js\":\"752e9e4373f4a8c0\",\"/knowledge-medium/src/utils/relativeDate.js\":\"57050ceac11e1125\",\"/knowledge-medium/src/utils/relativeTime.js\":\"2860090397d0d496\",\"/knowledge-medium/src/utils/renderScope.js\":\"11baf63b525fe5ed\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"008e728c8aa2d71f\",\"/knowledge-medium/src/utils/routing.js\":\"f679e0f27f0e582d\",\"/knowledge-medium/src/utils/safeMode.js\":\"229bb98bd9785c9b\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"6d04dc49caefd640\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"896aee785c76a18f\",\"/knowledge-medium/src/utils/selection.js\":\"7ca323dd95dec7e4\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b4fb2c10371145dd\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"e6e7f60ba6444fe7\",\"/knowledge-medium/src/utils/state.js\":\"6720431063219490\",\"/knowledge-medium/src/utils/string.js\":\"2561b9d0cc968454\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"62e3a1ac375db0ef\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"920dcdeecd6cbb21\",\"/knowledge-medium/src/utils/toast.js\":\"bdfe8b02787b86ec\",\"/knowledge-medium/src/utils/toggleStore.js\":\"1261d61725fc92e3\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"7aa26f4a5f4315c2\",\"/knowledge-medium/src/utils/userActivity.js\":\"49892a1ae8d07cb9\",\"/knowledge-medium/src/utils/viewTransition.js\":\"563f70b24dbe0fb7\",\"/knowledge-medium/src/utils/viewport.js\":\"914f810b9c91e161\",\"/knowledge-medium/src/utils/webLock.js\":\"59a8de86900d1d9f\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"c2c223d073361adc\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"b166ab4eadffcd5f\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"4649a600be0a906a\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"79682e46b634dbde\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"a98236522ade2a1a\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"870a2ab613a75e22\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"04e87d5e1432c015\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"b938a592722d98fb\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"c181a3c225179815\",\"/knowledge-medium/src/vendor/react-dom.js\":\"ffa0caf990efae40\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"6540a9be876cf95e\",\"/knowledge-medium/src/vendor/react.js\":\"b9372c0e41b116ef\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
