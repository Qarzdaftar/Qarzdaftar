"""Local, read-only Chrome QA for landing motion. Requires Python Playwright.

Run with the isolated browser fixture at 127.0.0.1:4310. Never uses the
user's Chrome profile or registers a real account. Screenshots go to qa/.
"""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:4310"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
OUT = Path("qa")
OUT.mkdir(exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=CHROME, headless=False)
    page = browser.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="no-preference")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        response = page.goto(BASE + "/", wait_until="load")
        assert response.status == 200
        page.evaluate("""() => {
            window.__motionMetrics = {longTasks: [], frames: []};
            if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
                new PerformanceObserver(list => {
                    for (const entry of list.getEntries()) window.__motionMetrics.longTasks.push(entry.duration);
                }).observe({entryTypes: ['longtask']});
            }
            let last;
            function sample(time) {
                if (last !== undefined) window.__motionMetrics.frames.push(time - last);
                last = time;
                requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        }""")
        first = page.locator(".preview").bounding_box()
        first_orbit = page.locator(".orbit-one").evaluate(
            "element => getComputedStyle(element).transform"
        )
        page.wait_for_timeout(800)
        middle = page.locator(".preview").bounding_box()
        page.wait_for_timeout(800)
        second = page.locator(".preview").bounding_box()
        second_orbit = page.locator(".orbit-one").evaluate(
            "element => getComputedStyle(element).transform"
        )
        # The ring rotates, not its symmetric outline; compare its own transform.
        ring = page.locator(".orbit-one")
        ring_transform = ring.evaluate("element => getComputedStyle(element).transform")
        positions = [first["y"], middle["y"], second["y"]]
        assert max(positions) - min(positions) > 1, positions
        assert page.locator(".preview").evaluate("element => getComputedStyle(element).animationName") == "sample-float"
        assert ring_transform != "none"
        assert first_orbit != second_orbit
        assert page.locator(".spark i").first.evaluate("element => getComputedStyle(element).animationName") == "bar-breathe"
        metrics = page.evaluate("window.__motionMetrics")
        frames = metrics["frames"]
        report = {"previewY": [round(position, 2) for position in positions],
                  "orbitTransforms": [first_orbit, second_orbit],
                  "performance": {"sampleFrames": len(frames),
                    "framesOver50ms": sum(duration > 50 for duration in frames),
                    "maxFrameMs": round(max(frames), 2) if frames else None,
                    "longTasksOver50ms": len(metrics["longTasks"]),
                    "maxLongTaskMs": round(max(metrics["longTasks"]), 2) if metrics["longTasks"] else 0}}
        page.screenshot(path=str(OUT / "motion-desktop.png"))
        for width in (320, 390, 768, 1440):
            page.set_viewport_size({"width": width, "height": 900})
            page.wait_for_timeout(150)
            layout = page.evaluate("""() => ({width: innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
                cta: (() => {const x = document.querySelector('.hero-actions .button').getBoundingClientRect();
                    return {left:x.left, right:x.right, width:x.width, height:x.height};})(),
                href: document.querySelector('.hero-actions .button').getAttribute('href')})""")
            if layout["scrollWidth"] > width + 1:
                layout["offenders"] = page.evaluate("""() => [...document.querySelectorAll('body *')]
                    .filter(element => element.getBoundingClientRect().right > innerWidth + 1)
                    .slice(0, 12).map(element => ({selector: element.className,
                        right: Math.round(element.getBoundingClientRect().right)}))""")
            assert layout["scrollWidth"] <= width + 1, layout
            assert layout["cta"]["left"] >= 0 and layout["cta"]["right"] <= width
            assert layout["cta"]["height"] >= 44 and layout["href"] == "/app#register"
            page.screenshot(path=str(OUT / f"motion-{width}.png"))
            report[str(width)] = layout
        page.get_by_role("link", name="14 kun bepul boshlash").click()
        assert page.url == BASE + "/app#register" and page.locator("#auth-form").is_visible()
        report["ctaDestination"] = page.url
        page.goto(BASE + "/", wait_until="load")
        page.emulate_media(reduced_motion="reduce")
        page.reload(wait_until="load")
        assert page.locator(".preview").evaluate("element => getComputedStyle(element).animationName") == "none"
        assert page.locator(".visual-orbit").first.evaluate("element => getComputedStyle(element).animationName") == "none"
        assert page.evaluate("getComputedStyle(document.documentElement).scrollBehavior") == "auto"
        before = page.locator(".preview").bounding_box()
        page.wait_for_timeout(400)
        after = page.locator(".preview").bounding_box()
        assert abs(after["y"] - before["y"]) < .1
        assert page.locator(".preview-card strong").is_visible()
        report["reducedMotion"] = "static visible preview, orbit and bars"
        page.emulate_media(reduced_motion="no-preference")
        page.reload(wait_until="load")
        page.locator(".hero-visual").hover()
        assert page.locator(".preview").evaluate("element => getComputedStyle(element).animationName") == "none"
        page.keyboard.press("Tab")
        assert page.evaluate("document.activeElement.matches('a,button,summary')")
        report["keyboardFocus"] = page.evaluate("document.activeElement.outerHTML.slice(0,120)")

        assert not errors, errors
        report["pageErrors"] = errors
        (OUT / "landing-motion-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        browser.close()
