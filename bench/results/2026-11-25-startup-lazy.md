# Benchmark results 2026-11-25-startup-lazy

Commit `1412339` (uncommitted changes), linux 6.18.58.1-microsoft-standard-WSL2, Intel(R) Core(TM) i9-14900K × 32, 31 GB. Load average at the end: 7.41.

| Metric | Value | Target | |
|---|---:|---:|---|
| `startup.dev.first_launch.first_paint_ms` | 400 ms |  |  |
| `startup.dev.first_launch.main_createWindow_ms` | 244 ms |  |  |
| `startup.dev.first_launch.main_readyToShow_ms` | 371 ms |  |  |
| `startup.dev.first_launch.main_spawn_ms` | 16.5 ms |  |  |
| `startup.dev.first_launch.main_whenReady_ms` | 218 ms |  |  |
| `startup.dev.first_launch.palette_median_ms` | 496 ms |  |  |
| `startup.dev.first_launch.palette_ms` | 455 ms |  |  |
| `startup.dev.first_launch.ready_ms` | 409 ms |  |  |
| `startup.dev.returning.first_paint_ms` | 376 ms |  |  |
| `startup.dev.returning.main_createWindow_ms` | 214 ms |  |  |
| `startup.dev.returning.main_readyToShow_ms` | 339 ms |  |  |
| `startup.dev.returning.main_spawn_ms` | 14.4 ms |  |  |
| `startup.dev.returning.main_whenReady_ms` | 206 ms |  |  |
| `startup.dev.returning.palette_median_ms` | 464 ms |  |  |
| `startup.dev.returning.palette_ms` | 435 ms |  |  |
| `startup.dev.returning.ready_ms` | 388 ms |  |  |
| `startup.packaged.first_launch.first_paint_ms` | 424 ms |  |  |
| `startup.packaged.first_launch.main_createWindow_ms` | 252 ms |  |  |
| `startup.packaged.first_launch.main_readyToShow_ms` | 381 ms |  |  |
| `startup.packaged.first_launch.main_spawn_ms` | 17.4 ms |  |  |
| `startup.packaged.first_launch.main_whenReady_ms` | 226 ms |  |  |
| `startup.packaged.first_launch.palette_median_ms` | 576 ms |  |  |
| `startup.packaged.first_launch.palette_ms` | 545 ms | ≤ 1500 | met |
| `startup.packaged.first_launch.ready_ms` | 450 ms |  |  |
| `startup.packaged.returning.first_paint_ms` | 389 ms | ≤ 1000 | met |
| `startup.packaged.returning.main_createWindow_ms` | 228 ms |  |  |
| `startup.packaged.returning.main_readyToShow_ms` | 355 ms |  |  |
| `startup.packaged.returning.main_spawn_ms` | 15.8 ms |  |  |
| `startup.packaged.returning.main_whenReady_ms` | 212 ms |  |  |
| `startup.packaged.returning.palette_median_ms` | 507 ms |  |  |
| `startup.packaged.returning.palette_ms` | 482 ms | ≤ 1500 | met |
| `startup.packaged.returning.ready_ms` | 413 ms |  |  |
