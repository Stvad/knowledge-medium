#!/usr/bin/env python3
"""Run an alternating, instrumented Chromium comparison on temporary archives."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BASE = "5619b6e4be5d843800c5e90d75984b442dd051ac"
PR = "35771148f1b9142df7b5cdc63cce4a0962593a46"
ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "diagnostic-results"
TEST = "src/plugins/html-document/test/boundary.browser.test.ts"
HARNESS = "src/plugins/html-document/test/boundaryHarness.ts"
HOST = "src/plugins/html-document/test/boundaryHost.tsx"


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one instrumentation match in {path.name}; found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def archive_revision(revision: str, destination: Path) -> None:
    destination.mkdir(parents=True)
    with (destination.parent / f"{revision}.tar").open("wb+") as archive_file:
        subprocess.run(
            ["git", "archive", "--format=tar", revision],
            cwd=ROOT,
            stdout=archive_file,
            check=True,
        )
        archive_file.flush()
        archive_file.seek(0)
        subprocess.run(["tar", "-xf", "-", "-C", str(destination)], stdin=archive_file, check=True)


def instrument(copy_root: Path) -> None:
    test = copy_root / TEST
    replace_once(
        test,
        "import {createHash} from 'node:crypto'",
        "import {createHash} from 'node:crypto'\nimport {appendFileSync} from 'node:fs'",
    )
    replace_once(
        test,
        """const documentFrame = (host: HostPage) => {
  const frame = host.page.frames().find(candidate => candidate.parentFrame()?.parentFrame() === host.page.mainFrame())
  if (!frame) throw new Error('no document frame')
  return frame
}""",
        """const documentFrame = (host: HostPage) => {
  const frames = host.page.frames()
  const frame = frames.find(candidate => candidate.parentFrame()?.parentFrame() === host.page.mainFrame())
  if (process.env.KM_FRAME_TRACE) appendFileSync(process.env.KM_FRAME_TRACE, `${JSON.stringify({kind: 'document-frame-lookup', at: process.hrtime.bigint().toString(), found: Boolean(frame), frames: frames.map(candidate => ({url: candidate.url(), parentUrl: candidate.parentFrame()?.url() ?? null}))})}\n`)
  if (!frame) throw new Error('no document frame')
  return frame
}""",
    )

    harness = copy_root / HARNESS
    replace_once(
        harness,
        "import dgram from 'node:dgram'",
        "import {appendFileSync} from 'node:fs'\nimport dgram from 'node:dgram'",
    )
    replace_once(
        harness,
        """  const page = await context.newPage()
  let popups = 0""",
        """  const page = await context.newPage()
  const tracePath = process.env.KM_FRAME_TRACE
  const frameIds = new WeakMap<object, number>()
  let nextFrameId = 1
  const frameId = (frame: object) => {
    let id = frameIds.get(frame)
    if (id === undefined) {
      id = nextFrameId++
      frameIds.set(frame, id)
    }
    return id
  }
  const traceFrame = (kind: string, frame: import('playwright').Frame) => {
    if (tracePath) appendFileSync(tracePath, `${JSON.stringify({kind, at: process.hrtime.bigint().toString(), id: frameId(frame), url: frame.url(), parentId: frame.parentFrame() ? frameId(frame.parentFrame()!) : null})}\n`)
  }
  page.on('frameattached', frame => traceFrame('frame-attached', frame))
  page.on('framedetached', frame => traceFrame('frame-detached', frame))
  page.on('framenavigated', frame => traceFrame('frame-navigated', frame))
  page.on('console', message => {
    const marker = message.text()
    const prefix = 'KM_FRAME_DIAGNOSTIC '
    if (tracePath && marker.startsWith(prefix)) {
      appendFileSync(tracePath, `${JSON.stringify({kind: 'host-marker', at: process.hrtime.bigint().toString(), marker: JSON.parse(marker.slice(prefix.length))})}\n`)
    }
  })
  let popups = 0""",
    )

    host = copy_root / HOST
    replace_once(
        host,
        """window.reports = []
window.channelReports = []
window.addEventListener('message', event => window.reports.push(event.data))""",
        """window.reports = []
window.channelReports = []
const diagnosticFrameIds = new WeakMap<HTMLIFrameElement, number>()
let nextDiagnosticFrameId = 1
const diagnosticFrameId = (frame: HTMLIFrameElement) => {
  let id = diagnosticFrameIds.get(frame)
  if (id === undefined) {
    id = nextDiagnosticFrameId++
    diagnosticFrameIds.set(frame, id)
  }
  return id
}
window.addEventListener('message', event => {
  window.reports.push(event.data)
  const frame = document.querySelector<HTMLIFrameElement>('#mount iframe')
  const data = event.data as {type?: unknown} | null
  console.debug('KM_FRAME_DIAGNOSTIC ' + JSON.stringify({kind: 'report', at: performance.now(), type: typeof data?.type === 'string' ? data.type : null, outerFrameId: frame ? diagnosticFrameId(frame) : null}))
})
const diagnosticMount = document.getElementById('mount')!
new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof HTMLIFrameElement) console.debug('KM_FRAME_DIAGNOSTIC ' + JSON.stringify({kind: 'outer-iframe-added', at: performance.now(), outerFrameId: diagnosticFrameId(node)}))
    }
    for (const node of record.removedNodes) {
      if (node instanceof HTMLIFrameElement) console.debug('KM_FRAME_DIAGNOSTIC ' + JSON.stringify({kind: 'outer-iframe-removed', at: performance.now(), outerFrameId: diagnosticFrameId(node)}))
    }
  }
}).observe(diagnosticMount, {childList: true, subtree: true})""",
    )


def version(command: list[str]) -> str:
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    return (result.stdout or result.stderr).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=5)
    arguments = parser.parse_args()
    if arguments.rounds < 1:
        parser.error("--rounds must be at least 1")
    run_order = [revision for _ in range(arguments.rounds) for revision in (BASE, PR)]

    RESULTS.mkdir(exist_ok=True)
    for item in RESULTS.iterdir():
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()

    versions = {
        "python": sys.version.split()[0],
        "node": version(["node", "--version"]),
        "pnpm": version(["pnpm", "--version"]),
        "vitest": version(["pnpm", "exec", "vitest", "--version"]),
        "playwright": version(["pnpm", "exec", "playwright", "--version"]),
    }
    (RESULTS / "versions.json").write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")

    results = []
    with tempfile.TemporaryDirectory(prefix="html-frame-diagnostic-") as temporary:
        temp_root = Path(temporary)
        archives = {revision: temp_root / f"archive-{revision}" for revision in (BASE, PR)}
        for revision, destination in archives.items():
            archive_revision(revision, destination)

        for index, revision in enumerate(run_order, start=1):
            label = "base" if revision == BASE else "pr"
            run_name = f"{index:02d}-{label}"
            run_dir = temp_root / run_name
            shutil.copytree(archives[revision], run_dir)
            node_modules = run_dir / "node_modules"
            node_modules.symlink_to(ROOT / "node_modules", target_is_directory=True)
            instrument(run_dir)

            run_results = RESULTS / run_name
            run_results.mkdir()
            trace_path = run_results / "frame-trace.jsonl"
            trace_path.touch()
            json_report = run_results / "vitest.json"
            command = [
                "pnpm", "exec", "vitest", "run", "--config", "vitest.browser.config.ts",
                "--reporter=json", "--outputFile", str(json_report),
            ]
            environment = os.environ.copy()
            environment["KM_BOUNDARY_ENGINES"] = "chromium"
            environment["KM_FRAME_TRACE"] = str(trace_path)
            started = time.monotonic()
            timed_out = False
            process = subprocess.Popen(
                command,
                cwd=run_dir,
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            try:
                stdout, stderr = process.communicate(timeout=180)
                exit_code = process.returncode
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
                exit_code = None
            elapsed = round(time.monotonic() - started, 3)
            (run_results / "stdout.txt").write_text(stdout, encoding="utf-8")
            (run_results / "stderr.txt").write_text(stderr, encoding="utf-8")
            if not json_report.exists():
                json_report.write_text("", encoding="utf-8")
            record = {
                "order": index,
                "revision": revision,
                "label": label,
                "duration_seconds": elapsed,
                "timeout_seconds": 180,
                "timed_out": timed_out,
                "exit_code": exit_code,
                "stdout": f"{run_name}/stdout.txt",
                "stderr": f"{run_name}/stderr.txt",
                "json_report": f"{run_name}/vitest.json",
                "frame_trace": f"{run_name}/frame-trace.jsonl",
            }
            results.append(record)
            print(json.dumps(record), flush=True)

    summary = {"versions": versions, "runs": results, "passed": all(item["exit_code"] == 0 and not item["timed_out"] for item in results)}
    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
