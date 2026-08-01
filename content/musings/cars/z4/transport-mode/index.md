---
title: How to fix transport mode on a BMW Z4 E85 (2007)
subtitle: Blower barely runs after a dead battery? It's probably this.
date: '2026-08-01'
tags:
  - bmw
  - z4
  - e85
  - coding
  - diy
featured_image: null
draft: false
seo:
  description: >-
    The Tool32 job that clears transport mode (Energiesparmodus) on a Z4 E85
    after a dead battery kills the blower, A/C, and defrost.
  keywords:
    - bmw z4 e85 transport mode
    - bmw z4 e86 coupe transport mode
    - energiesparmodus aktiv
    - bmw blower not working after dead battery
    - tool32 ihka85
    - bmw e85 ac not working
    - k+dcan coding
---

My battery died and was replaced. Next time I used the car, the defrost fan
would barely run. Googling turned up transport mode: a low-battery safety
mode that disables the blower above minimum speed, the A/C, and the defrost.
If you're seeing those symptoms after a dead battery, it's probably
transport mode. Mine is a 2007 roadster, but this applies to the whole
E85/E86 family — 2003–2008, roadster and coupe.

> *Disclaimer: This is a record of what worked on my own car, shared for
> informational purposes only. It is not professional advice, and no
> warranty of any kind is made. Working on vehicle electronics carries
> risk, including permanent damage to control modules. By following
> anything here, you assume all risk; I accept no liability for any
> resulting damage or injury. When in doubt, take the car to a qualified
> professional.*

## The fix

This assumes you already have the E-chassis coding stack working — a K+DCAN
cable and [BMW Standard Tools](https://www.bimmerpost.com/forums/showthread.php?t=1196830)
(EDIABAS, INPA, Tool32) installed, with INPA showing both dots when the
ignition is on. Setting that up is its own project; that thread covers it.

1. Ignition on, cable plugged in.
2. Open **Tool32**.
3. File → Load SGBD → `C:\EDIABAS\ECU\IHKA85.prg` — the E85 climate module.
4. In the Jobs list, select `ENERGIESPARMODE`.
5. In the Arguments field, type `aus` (German: off).
6. Run the job (F5). You want `OKEY` in the results pane.

My blower came back the moment the job ran. No restart, no battery
disconnect.

### If Tool32 hangs loading IHKA85.prg

Mine sat on a spinner and then threw a runtime error. That's a missing
Windows control, not a car problem. From an admin command prompt:

```
regsvr32 "C:\EDIABAS\BIN\msflxgrd.ocx"
```

On 64-bit Windows the file belongs in `C:\Windows\SysWOW64` and you register
it with `C:\Windows\SysWOW64\regsvr32.exe`. Reopen Tool32 and load the
module again.

## Verify it stuck

- Blower runs through the full range, not just above zero.
- A/C button — LED stays lit, air goes cold.
- Rear defroster — LED holds.
- Key off, key back on, check again. If the state didn't stick you want to
  know now, not next week.
- In INPA, read the IHKA fault memory. `Energiesparmodus aktiv` should be
  gone; clear whatever's left.

If the convertible top is also dead, the roof module (CVM) holds its own
energy-saving flag. Same procedure — load the convertible module's `.prg`
instead and run the same job.

## Backstory

The IHKA (climate module) flags itself into energy-saving mode when it sees
battery voltage drop too low, and it doesn't clear the flag on its own.
INPA's fault reading calls it `Energiesparmodus aktiv`; forums call it
transport mode, since it's the same starved-electrics state cars ship from
the factory in. NCS Expert can't fix it — it's not a coding parameter, it's
a status stored in the module, so you have to command the module directly.
That's what the Tool32 job does.

One catch: if your battery was recharged rather than replaced, expect the
mode to come back after the next cold night. The lasting fix is a healthy
battery. Mine was new, so it stuck.

## Alternatives

- **DIS / SSS Progman** — the dealer tools. Reliable, but they're DVD-sized
  images usually run in a VM. Overkill for one flag.
- **BMW Scanner 1.4 (PA Soft)** — cheap cable and software with a reset for
  this baked in.
- **Foxwell NT530** — handheld scanner, clears it in a few menu presses.
  The no-laptop option.
