# History and the monthly report

## Graphs

Small graphs on the device cards, in their details and on the VMs page show the history of power, temperatures, CPU and memory, traffic, response times and more. Point at a graph for the value and time.

Ranges: **24 h**, **7 d**, **30 d**, **90 d** and **1 y** (remembered per browser). When the history is shorter than the range, the graph starts at its first point and says *since …*.

| Kept | Resolution |
|---|---|
| 25 hours | 1-minute averages |
| 8 days | 15-minute averages |
| 92 days | 2-hour averages |
| 2 years | each day's average, lowest and highest |

Also recorded: how full each storage is (for the forecast) and whether each connection answered (for uptime). On Node.js 22.5 and newer the history is stored in `history.db` (SQLite, built into Node), with a point written when its period is over; on older Node it is `history.json`. Backups contain it either way. Graphs for removed devices are dropped after 30 days. Only numbers are kept, no names or addresses.

## Monthly report

![Monthly report](../guide/img/report.png)

**Report** in the top bar sums up a month, compared with the month before:

- **Service uptime** (the average of all checked services), the number of **problems** (how many critical, how many acknowledged), the **time with problems** and how long they took to clear, and the month's **energy** and cost.
- **Services** and **Devices**: each one's uptime, how long it was down, and how many problems it had, worst first. Uptime comes from the status checks and from whether a device's connections answered. Time in maintenance doesn't count, nor do problems behind another outage.
- **Longest problems** of the month.
- **Storage**: how full each one is, how much it grew this month, how fast it grows (percentage points a month), and when it will be full at that pace.

**‹ ›** and the menu choose the month; **Print or save as PDF** makes a clean printout.

## Storage forecast

From the daily level of each storage over the last 60 days, the dashboard draws a straight line and works out when it will be full. It needs at least a week of readings, and ignores storage that isn't growing.

- A storage that will be full **within 30 days** shows under *Needs you* as *Storage almost full* ("vault: pool tank will be full in about 21 days"), before it reaches the limit.
- A device's details list what is **filling up**.
- The report lists every storage with its growth and forecast.

Storage covered: Proxmox storages and ZFS pools, container disks, VM filesystems (guest agent), TrueNAS pools, Synology and SNMP volumes, and every filesystem a [Linux agent](linux-agents.md) reports.
