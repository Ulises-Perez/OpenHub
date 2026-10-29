# OpenHub

Catálogo propio de plugins de OpenCode. Sin servidores, sin base de datos, sin coste: un crawler diario en GitHub Actions publica un JSON que consume la tienda de OpenCode.

```
https://raw.githubusercontent.com/<usuario>/OpenHub/data/plugins.json
```

## Qué hay acá

| Archivo | Rol |
|---|---|
| `crawl.mjs` | el crawler completo (Node 22, cero dependencias) |
| `categories.mjs` | tabla keyword → categoría, ordenada por especificidad |
| `overrides.json` | correcciones manuales de categoría (`slug → categoría`) |
| `scripts/publish-data.sh` | publica el JSON a la rama `data` como commit único |
| `.github/workflows/crawl.yml` | cron diario |
| `plugins.json` | salida (solo existe en la rama `data`) |

## Uso local

```bash
node crawl.mjs --self-test      # asserts offline, sin red
node crawl.mjs --limit=80       # corrida parcial, para probar
GITHUB_TOKEN=$(gh auth token) node crawl.mjs   # completa, con stars
```

Escribe `plugins.json` + `plugins.digest` (sha256 del array de plugins, sin el timestamp, para detectar cambios reales).

## Fuentes

- **npm search** (`registry.npmjs.org/-/v1/search`) — 4 queries, máximo 20 páginas de 250 por query.
- **npm metadata** — `application/vnd.npm.install-v1+json` (2,4–3,6× más chica que el packument completo).
- **npm downloads** (`api.npmjs.org/downloads/point`) — lotes de 50 sin scope; uno por paquete con scope.
- **GitHub GraphQL** — stars, forks, archived, `pushedAt`, topics. 50 repos por query con alias.

### Límites que condicionan el diseño

- `from` > ~5000 devuelve **la página 1 otra vez**, sin error. El crawler corta cuando detecta el wrap.
- `keywords:` es match **exacto de token**, nunca descripción. Por eso se unen varias queries.
- `keywords:opencode` tiene ~10k resultados: se lee hasta el techo de 5.000, que cubre todo lo relevante.
- Los paquetes con scope son **rechazados por el bulk de descargas**.
- La búsqueda **devuelve 429 en ráfagas y sin `Retry-After`**: hay 600 ms entre páginas y reintentos con backoff largo.
- La metadata abreviada **no trae `main`/`exports`**, así que la estructura del paquete no se inspecciona. En vez de adivinar con heurísticas, solo se excluyen los paquetes core oficiales (`@opencode/*`, `@opencode-ai/*`, `opencode-ai`): una heurística estructural descartaba plugins reales de forma medible.

## Cómo se categoriza

Orden por especificidad, primer match gana, entradas múltiples permitidas. Detalle completo en `categories.mjs`.

| # | Categoría |
|---|---|
| 1 | `mcp` |
| 2 | `providers` |
| 3 | `auth` |
| 4 | `memory` |
| 5 | `observability` |
| 6 | `notify` |
| 7 | `git` |
| 8 | `lsp` |
| 9 | `ui` |
| 10 | `agents` |
| 11 | `testing` |
| 12 | `infra` |
| 13 | `tools` |
| 14 | `other` |

`overrides.json` corrige a mano lo que el keyword no dice. Es la única curaduría; nada es editorial por defecto.

## Score

```
0.35·stars + 0.35·downloads + 0.20·actividad + 0.10·crecimiento
```

- Todo log-normalizado; `archived` multiplica ×0.35.
- Corrección anti-monorepo: `credStars = min(stars, max(downloadsMonth × 8, 1000))`.
- `actividad` = días desde `pushedAt`, decae lineal a 365 días.
- `crecimiento` = `(downloadsWeek × 4.3) / downloadsMonth`.

Es informativo: la tienda ordena por descargas, estrellas, recencia o nombre.

## Compatibilidad v1 / v2

| | v1 | v2 |
|---|---|---|
| SDK | `@opencode-ai/plugin` 1.x | `@opencode/plugin` 2.x |
| Entry | `{ server(input) }` | `Plugin.define({ id, setup })` |
| Config | `plugin: []` (deprecado, se sigue aceptando) | `plugins: []` |
| Partes | solo server | `./server`, `./tui`, `./rpc`, `./gui-experimental` |

Un plugin v1 **carga igual en v2**. Por eso `compat` es un badge informativo (`v2` / `v1` / `both` / `unknown`), nunca un filtro: hay plugins que funcionan en ambas sin declarar nada.

Detección en tres señales: dependencias declaradas → entrada (`main`/`exports`, solo si la primera falla) → keywords de harness (`targets`).

## Mantenimiento

`active` / `stale` / `archived`, derivado de `archived`, `deprecated` y días desde `pushedAt` (>365 → stale).

## Licencia

MIT. Los datos son metadata pública de npm y GitHub.
