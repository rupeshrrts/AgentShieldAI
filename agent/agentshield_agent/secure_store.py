"""Private keys at rest: Windows DPAPI (machine scope) on Windows, plain bytes elsewhere (development only).

The data folder itself is limited to SYSTEM and Administrators (`install` sets the ACL). DPAPI adds
that a copy of the files taken off this PC (backup, disk image) cannot be decrypted elsewhere.
"""
import ctypes
import sys

_MAGIC = b"ASDPAPI1"
CRYPTPROTECT_UI_FORBIDDEN = 0x01
CRYPTPROTECT_LOCAL_MACHINE = 0x04


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _Blob:
    buf = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))


def _call(fn_name: str, data: bytes) -> bytes:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    src, out = _blob(data), _Blob()
    fn = getattr(crypt32, fn_name)
    flags = CRYPTPROTECT_UI_FORBIDDEN | (CRYPTPROTECT_LOCAL_MACHINE if fn_name == "CryptProtectData" else 0)
    if not fn(ctypes.byref(src), None, None, None, None, flags, ctypes.byref(out)):
        raise OSError(f"{fn_name} failed (Windows error {ctypes.GetLastError()})")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def protect(data: bytes) -> bytes:
    if sys.platform != "win32":
        return data
    return _MAGIC + _call("CryptProtectData", data)


def unprotect(data: bytes) -> bytes:
    if not data.startswith(_MAGIC):
        return data
    return _call("CryptUnprotectData", data[len(_MAGIC):])
