"""Teto Player: печатает песню и строки текста в реальном времени. Python 3, без зависимостей.
python teto_now.py [порт]"""
import json, sys, time, urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7710
URL = f"http://127.0.0.1:{PORT}/v1/events?pos=0"

def run():
    with urllib.request.urlopen(URL) as r:
        ev = None
        for raw in r:
            s = raw.decode("utf-8").rstrip("\r\n")
            if s.startswith("event:"):
                ev = s[6:].strip()
            elif s.startswith("data:") and ev:
                d = json.loads(s[5:])
                if ev in ("hello", "track"):
                    t = d.get("track")
                    print(f"\n▶ {t['artist']} — {t['title']}" if t else "\n■ остановлено", flush=True)
                elif ev == "state":
                    print(f"  [{d['state']}]", flush=True)
                elif ev == "line" and d.get("line"):
                    print("  ♪", d["line"]["text"], flush=True)

while True:
    try:
        run()
    except Exception as e:
        print("нет соединения с Teto Player:", e, "— повтор через 3 с", file=sys.stderr)
        time.sleep(3)
