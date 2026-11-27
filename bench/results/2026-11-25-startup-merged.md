# Benchmark results 2026-11-25-startup-merged

Commit `1412339` (uncommitted changes), linux 6.18.58.1-microsoft-standard-WSL2, Intel(R) Core(TM) i9-14900K × 32, 31 GB. Load average at the end: 7.31.

| Metric | Value | Target | |
|---|---:|---:|---|
| `startup.dev.first_launch.first_paint_ms` | 446 ms |  |  |
| `startup.dev.first_launch.main_createWindow_ms` | 272 ms |  |  |
| `startup.dev.first_launch.main_readyToShow_ms` | 394 ms |  |  |
| `startup.dev.first_launch.main_spawn_ms` | 14.8 ms |  |  |
| `startup.dev.first_launch.main_whenReady_ms` | 235 ms |  |  |
| `startup.dev.first_launch.palette_median_ms` | 524 ms |  |  |
| `startup.dev.first_launch.palette_ms` | 514 ms |  |  |
| `startup.dev.first_launch.ready_ms` | 460 ms |  |  |
| `startup.dev.returning.first_paint_ms` | 423 ms |  |  |
| `startup.dev.returning.main_createWindow_ms` | 245 ms |  |  |
| `startup.dev.returning.main_readyToShow_ms` | 371 ms |  |  |
| `startup.dev.returning.main_spawn_ms` | 14.5 ms |  |  |
| `startup.dev.returning.main_whenReady_ms` | 237 ms |  |  |
| `startup.dev.returning.palette_median_ms` | 495 ms |  |  |
| `startup.dev.returning.palette_ms` | 484 ms |  |  |
| `startup.dev.returning.ready_ms` | 435 ms |  |  |
| `startup.packaged.first_launch.first_paint_ms` | 431 ms |  |  |
| `startup.packaged.first_launch.main_createWindow_ms` | 272 ms |  |  |
| `startup.packaged.first_launch.main_readyToShow_ms` | 405 ms |  |  |
| `startup.packaged.first_launch.main_spawn_ms` | 15.2 ms |  |  |
| `startup.packaged.first_launch.main_whenReady_ms` | 244 ms |  |  |
| `startup.packaged.first_launch.palette_median_ms` | 595 ms |  |  |
| `startup.packaged.first_launch.palette_ms` | 560 ms | ≤ 1500 | met |
| `startup.packaged.first_launch.ready_ms` | 454 ms |  |  |
| `startup.packaged.returning.first_paint_ms` | 359 ms | ≤ 1000 | met |
| `startup.packaged.returning.main_createWindow_ms` | 255 ms |  |  |
| `startup.packaged.returning.main_readyToShow_ms` | 372 ms |  |  |
| `startup.packaged.returning.main_spawn_ms` | 16.4 ms |  |  |
| `startup.packaged.returning.main_whenReady_ms` | 238 ms |  |  |
| `startup.packaged.returning.palette_median_ms` | 518 ms |  |  |
| `startup.packaged.returning.palette_ms` | 502 ms | ≤ 1500 | met |
| `startup.packaged.returning.ready_ms` | 431 ms |  |  |
