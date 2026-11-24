# S7 driver — Verify on real hardware

Everything below was implemented from public protocol descriptions (Wireshark
S7comm dissector, Apache PLC4X S7 docs, Snap7 docs, G. Miru's S7 write-ups)
and checked only against `server/test/support/s7Simulator.js`, which was
written by the same author. Each item needs a capture (Wireshark, `s7comm`
filter) or an observation on a real CPU before the driver leaves
"experimental".

1. **PDU accounting.** The planner assumes the negotiated PDU size covers the
   S7 header + parameters + data (not TPKT/COTP), a 10-byte request header +
   2 + 12 per Read Var item, and a 12-byte response header + 2 + (4 + length
   + fill byte) per item. Check that a request planned to exactly the limit
   (e.g. one 222-byte item at PDU 240, 19 items at PDU 240) is accepted, and
   that 20 items at PDU 240 would indeed be refused.
2. **Max items per request.** 20 is the documented S7-300/400 limit; check
   S7-1200/1500 accept 20 and do not impose a lower number.
3. **Fill byte.** Response items of odd length are followed by one fill byte
   except after the last item. Confirm on a multi-item read with odd lengths.
4. **Response transport size / length units.** The parser treats data
   transport sizes 0x03 (BIT), 0x04 (BYTE/WORD/DWORD) and 0x05 (INTEGER) as
   lengths in bits, everything else (0x07 REAL, 0x09 OCTET STRING) in bytes.
   All requests use transport size BYTE (0x02); confirm the CPU answers 0x04.
5. **Item return codes on real firmware.** Mapping used: 0x05 → "DB shorter
   than the requested range", 0x0A → "DB does not exist", 0x03 → PUT/GET /
   optimized access / protection. Observe what an S7-1200/1500 actually
   returns for (a) a non-existent DB, (b) a read past the end of a DB, (c) a
   DB with optimized block access ON, (d) a protection level that blocks reads.
6. **Header-level refusal with PUT/GET disabled.** Assumed to arrive as
   ack-data error class 0x81 / code 0x04 (0x8104). Confirm on S7-1200 and
   S7-1500 with "Permit access with PUT/GET" OFF, including whether it comes
   at setup communication or only at the first Read Var.
7. **Rack/slot → TSAP.** Remote TSAP = 0x0100 | rack × 0x20 + slot ("PG"
   connection type, as Snap7's default), local TSAP 0x0100. Check S7-300
   (0/2), S7-400 (rack/slot of the CPU), S7-1200/1500 (0/1), and LOGO!/drives
   via raw TSAP. Some sites prefer the OP (0x02) connection type to keep the
   PG resource free; the driver only offers that via remoteTsap override.
8. **COTP CR parameters.** TPDU size 1024 (code 0x0A) is requested. Confirm
   the CPU's CC and that no CPU fragments S7 PDUs over several DT TPDUs at
   PDU 960 (the parser reassembles fragments anyway).
9. **SZL layouts used for identity** (best effort; failures are skipped,
   and a CPU that ignores SZL is reconnected without identity):
   - 0x011C index 1/2/5/7 → system name / module name / serial number /
     module type name, 34-byte records (index + 32 chars);
   - 0x0111 index 1 → order code in record bytes 2..21;
   - 0x0111 index 7 → firmware as record bytes 25/26/27 (V major.minor.patch);
   - 0x0424 index 0 → CPU mode from the low nibble of record byte 3
     (8 = RUN, 1-4 = STOP, 5-7 = STARTUP, 10 = HOLD). Sources disagree on the
     byte offset; this is the least certain item.
   Only the first SZL data unit is read; continuation units are not requested.
   Check which of these SZLs S7-1200/1500 answer at all.
10. **Setup communication.** max AmQ calling/called are requested as 1 and the
    driver never has more than one job in flight regardless. Confirm the
    negotiated PDU on each CPU family (expected 240 S7-300, 480 S7-400, 960
    S7-1500, 240 S7-1200 depending on firmware).
11. **STRING encoding.** STRING/CHAR are decoded as latin1 (ISO-8859-1);
    the CPU stores bytes in the engineering station's code page (usually
    Windows-1252). Characters 0x80-0x9F will differ.
12. **Date/time.** DATE_AND_TIME years 90-99 → 1990s, 00-89 → 2000s; DTL
    validated to 1970..2554. Values are emitted as zone-less wall-clock ISO
    text. Check against a CPU with a known clock.
13. **Large values are not atomic.** A tag larger than one PDU is read in
    several sequential jobs; the PLC can change it between them.
14. **Connection resources.** Each driver instance holds exactly one
    connection; check the CPU's connection diagnostics show one PG/OP
    resource in use and that it is released on `close()` (FIN) and after a
    timeout (socket destroyed, CPU-side release may lag).
