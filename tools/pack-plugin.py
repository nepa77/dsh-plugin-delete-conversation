"""把 dsh-plugin-delete-conversation 打包成可以直接装到另一台机器上的产物。

在 `dist/` 下生成两个自包含产物，内容都由 `package.json` 的 `files` 列表决定，
因此产物与清单不会各说各话：

  dsh-plugin-delete-conversation-<版本>.tgz   npm/pnpm 打包格式（所有内容在 `package/` 下）
  dsh-plugin-delete-conversation-<版本>.zip   解压即得到一个目录，最省事

生成之后**验证**而不是"相信它"：把 tarball 解到临时目录，对两个半边做语法检查，
再从解压出来的副本跑一遍包内测试。一个无法自检的包不值得发布。

运行：python tools/pack-plugin.py
"""

import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from shutil import which

HERE = os.path.dirname(os.path.abspath(__file__))
# 仓库根目录就是插件包目录。
PKG = os.path.normpath(os.path.join(HERE, ".."))
DIST = os.path.join(PKG, "dist")
PACKAGE_NAME = "dsh-plugin-delete-conversation"
# npm 一定要有清单文件，无论如何都要打进去。
ALWAYS = ["package.json"]


def find_node():
    """优先用 PATH 上的 node；没有就退回 DSH 运行时自带的那一个。"""
    found = which("node")
    if found:
        return found
    dsh_home = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh"))
    candidate = os.path.join(
        dsh_home, "dsh-runtimes", "dsh-primary-runtime", "dependencies",
        "node", "bin", "node.exe",
    )
    return candidate if os.path.exists(candidate) else None


def collect():
    """按清单收集要发布的文件，返回 (清单, [(仓库内相对路径, 绝对路径)])。"""
    manifest = json.load(io.open(os.path.join(PKG, "package.json"), encoding="utf-8"))
    wanted = list(manifest.get("files", [])) + ALWAYS
    entries = []
    seen = set()
    for item in wanted:
        source = os.path.join(PKG, item)
        if os.path.isfile(source):
            candidates = [source]
        elif os.path.isdir(source):
            candidates = []
            for base, _dirs, names in os.walk(source):
                for name in sorted(names):
                    candidates.append(os.path.join(base, name))
        else:
            raise SystemExit("清单里列了一个不存在的路径：%s" % item)
        for path in candidates:
            relative = os.path.relpath(path, PKG).replace(os.sep, "/")
            if relative in seen:
                continue
            seen.add(relative)
            entries.append((relative, path))
    entries.sort()
    return manifest, entries


def deterministic_tarinfo(name, size, mode):
    """固定时间戳与属主，保证同样的内容每次都产出同样的字节。"""
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = mode
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    return info


def write_tgz(path, entries):
    """npm 兼容的 tarball：gzip 压缩的 tar，所有条目都在 `package/` 下。"""
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
                manifest_bytes = io.open(os.path.join(PKG, "package.json"), "rb").read()
                info = deterministic_tarinfo("package/package.json", len(manifest_bytes), 0o644)
                tar.addfile(info, io.BytesIO(manifest_bytes))
                for relative, source in entries:
                    if relative == "package.json":
                        continue
                    data = open(source, "rb").read()
                    executable = relative.endswith(".sh") or relative.endswith(".ps1")
                    info = deterministic_tarinfo(
                        "package/" + relative, len(data), 0o755 if executable else 0o644
                    )
                    tar.addfile(info, io.BytesIO(data))
    return path


def write_zip(path, entries):
    """同一棵树放进一个顶层目录，解压后直接就是一个插件目录。"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        manifest_bytes = io.open(os.path.join(PKG, "package.json"), "rb").read()
        info = zipfile.ZipInfo("%s/package.json" % PACKAGE_NAME, date_time=(1980, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        archive.writestr(info, manifest_bytes)
        for relative, source in entries:
            if relative == "package.json":
                continue
            info = zipfile.ZipInfo("%s/%s" % (PACKAGE_NAME, relative), date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, open(source, "rb").read())
    return path


def verify_tgz(path):
    """解压 tarball，对两个半边做语法检查，并从解压副本跑包内测试。"""
    node = find_node()
    if node is None:
        return ["找不到 node，跳过了'从解压副本自检'这一步"]
    problems = []
    workdir = tempfile.mkdtemp(prefix="dsh-delete-conversation-pack-")
    try:
        with tarfile.open(path, "r:gz") as tar:
            names = tar.getnames()
            for name in names:
                # 拒绝任何可能写到解压目录之外的条目。
                if name.startswith("/") or ".." in name.split("/"):
                    return ["tarball 里有不安全的条目：%s" % name]
            tar.extractall(workdir)
        extracted = os.path.join(workdir, "package")
        for relative in ("src/index.js", "src/client.js"):
            target = os.path.join(extracted, relative.replace("/", os.sep))
            if not os.path.exists(target):
                problems.append("tarball 里缺少 %s" % relative)
                continue
            result = subprocess.run(
                [node, "--check", target], capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            if result.returncode != 0:
                problems.append("%s 语法检查失败：%s" % (relative, result.stderr.strip()))
        # 真正的证据：用**打进去的文件**跑**打进去的测试**。
        test = os.path.join(extracted, "test", "delete-conversation.test.mjs")
        if not os.path.exists(test):
            problems.append("tarball 没有带上自己的测试")
        else:
            result = subprocess.run(
                [node, test], capture_output=True, text=True, cwd=extracted,
                encoding="utf-8", errors="replace",
            )
            tail = (result.stdout or "").strip().splitlines()
            summary = tail[-1] if tail else "(没有输出)"
            if result.returncode != 0:
                problems.append("解压出来的包没有通过自己的测试：%s" % summary)
                for line in tail[-12:]:
                    problems.append("    " + line)
            else:
                print("    解压副本自检：%s" % summary)
        print("    tarball 共 %d 个条目" % len(names))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return problems


def main():
    # 输出里有中文，别让控制台的默认编码把它弄乱。
    sys.stdout.reconfigure(encoding="utf-8")
    manifest, entries = collect()
    version = manifest["version"]
    os.makedirs(DIST, exist_ok=True)

    tgz = os.path.join(DIST, "%s-%s.tgz" % (PACKAGE_NAME, version))
    zip_path = os.path.join(DIST, "%s-%s.zip" % (PACKAGE_NAME, version))
    for stale in (tgz, zip_path):
        if os.path.exists(stale):
            os.remove(stale)

    write_tgz(tgz, entries)
    write_zip(zip_path, entries)

    print("已打包 %s @ %s" % (manifest["name"], version))
    print("  依据清单 files 列表，共 %d 个文件" % len(entries))
    print("")
    print("  %-52s %9d 字节" % (os.path.basename(tgz), os.path.getsize(tgz)))
    print("  %-52s %9d 字节" % (os.path.basename(zip_path), os.path.getsize(zip_path)))
    for path in (tgz, zip_path):
        digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
        print("  sha256 %s  %s" % (digest[:16] + "...", os.path.basename(path)))
    print("")
    print("解压 tarball 进行验证：")
    problems = verify_tgz(tgz)
    if problems:
        print("")
        print("验证失败：")
        for line in problems:
            print("  " + line)
        return 1
    print("")
    print("通过：tarball 自包含，并且能跑通自己的测试")
    print("")
    print("装到另一台机器（两个产物任选其一）：")
    print("  dsh plugin --profile <profile> add %s" % tgz)
    print("  # 或者解压 .zip，然后让 plugin_manager install_bundle 指向那个目录")
    return 0


if __name__ == "__main__":
    sys.exit(main())
