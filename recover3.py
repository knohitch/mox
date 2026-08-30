import json

with open(r"C:\Users\Administrator\.gemini\antigravity\brain\7cba3483-3345-465f-8141-d9592a9bc54e\.system_generated\logs\transcript_full.jsonl", "r", encoding="utf-8") as f:
    for line in f:
        try:
            d = json.loads(line)
            if "tool_calls" in d:
                for t in d["tool_calls"]:
                    if "replace_file_content" in t.get("name", ""):
                        args = t.get("arguments", {})
                        if "styles.css" in args.get("TargetFile", ""):
                            rc = args.get("ReplacementContent", "")
                            if "aw-workspace" in rc or "aw-hub" in rc or "aw-" in rc:
                                print(rc)
                                print("===SEP===")
        except:
            pass
