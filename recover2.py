import json
import re

content = ""
with open(r"C:\Users\Administrator\.gemini\antigravity\brain\7cba3483-3345-465f-8141-d9592a9bc54e\.system_generated\logs\transcript_full.jsonl", "r", encoding="utf-8") as f:
    for line in f:
        try:
            d = json.loads(line)
            if "tool_calls" in d:
                for t in d["tool_calls"]:
                    if "run_command" in t.get("name", ""):
                        cmd = t.get("arguments", {}).get("CommandLine", "")
                        if "styles.css" in cmd and "EOF" in cmd:
                            content += cmd + "\n================\n"
        except Exception as e:
            pass

with open(r"E:\aw-css-cmds.txt", "w", encoding="utf-8") as out:
    out.write(content)
