"""把会话日志里被压缩掉的原文恢复回来，同时剔除工具回显。

用法：python restore_transform.py <输入.zstd> <输出.zstd>

做三件事：
  1. 所有 tool/result 的长回显 → 换成一行 `[工具名 输出已剔除 · N 字符]`
     含图片等非文本块的一律跳过（否则 image/offload 的图片索引会悬空）
  2. 那条把原文替换成摘要的 user/message → 改成未知类型 + ignorable:true
     （未知类型必须标 ignorable，否则 harness 拒绝加载整份日志）
  3. 两帧写出：第一帧只装 session 头那一行，第二帧装其余全部

不做的事：不动 session id、不动 seq、不动任何交叉引用。
"""
import json
import sys

import zstandard

MIN_ELIDE = 400


def main(src: str, dst: str) -> None:
    dec = zstandard.ZstdDecompressor()
    with open(src, "rb") as f:
        data = dec.stream_reader(f).read()

    parts = data.split(b"\n")  # 全程按字节切，避免 universal newlines 破坏行结构

    names = {}
    summary_seq = None
    for p in parts:
        if not p.strip():
            continue
        try:
            o = json.loads(p)
        except Exception:
            continue
        t = o.get("type")
        dd = o.get("data") or {}
        if t == "assistant/message":
            for c in (dd.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool-call" and c.get("id"):
                    names[c["id"]] = c.get("name", "tool")
        elif t == "user/message":
            so = o.get("surfaceOp")
            if isinstance(so, dict) and so.get("op") == "replace":
                summary_seq = o.get("seq")

    elided = skipped = unshadowed = 0
    chars_before = chars_after = 0

    for i, p in enumerate(parts):
        if not p.strip():
            continue
        o = json.loads(p)
        t = o.get("type")

        if t == "tool/result":
            dd = o.get("data") or {}
            m = dd.get("message") or {}
            blocks = m.get("content") or []
            if any(isinstance(b, dict) and b.get("type") != "text" for b in blocks):
                skipped += 1
                continue
            total = sum(
                len(b.get("text") or "")
                for b in blocks
                if isinstance(b, dict) and b.get("type") == "text"
            )
            if total < MIN_ELIDE:
                continue
            src_obj = m.get("source")
            cid = (src_obj.get("callId") if isinstance(src_obj, dict) else None) or m.get("toolCallId")
            nm = names.get(cid, "tool")
            err = " · 报错" if dd.get("isError") else ""
            new_text = "[%s 输出已剔除 · %d 字符%s]" % (nm, total, err)
            m["content"] = [{"type": "text", "text": new_text}]
            dd["message"] = m
            o["data"] = dd
            chars_before += total
            chars_after += len(new_text)
            elided += 1
            parts[i] = json.dumps(o, ensure_ascii=False).encode("utf-8")

        elif t == "user/message" and o.get("seq") == summary_seq:
            o["type"] = "compaction/restored"
            o["ignorable"] = True
            o.pop("surfaceOp", None)
            o.pop("sourceEventSeqs", None)
            parts[i] = json.dumps(o, ensure_ascii=False).encode("utf-8")
            unshadowed += 1

    head = parts[0] + b"\n"
    rest = b"\n".join(parts[1:])

    cctx = zstandard.ZstdCompressor(level=5)
    with open(dst, "wb") as fo:
        c1 = cctx.compressobj()
        fo.write(c1.compress(head))
        fo.write(c1.flush())
        c2 = cctx.compressobj()
        fo.write(c2.compress(rest))
        fo.write(c2.flush())

    pct = 100 * (chars_before - chars_after) / max(chars_before, 1)
    print("elided=%d skipped_media=%d unshadowed=%d removed_chars=%d (%.1f%%)"
          % (elided, skipped, unshadowed, chars_before - chars_after, pct))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
