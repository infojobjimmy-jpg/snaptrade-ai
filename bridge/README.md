# SnapTrade AI — Pont d'exécution MT5

`SnapTradeBridge.mq5` fait le lien entre l'app (Railway) et un terminal MetaTrader 5
qui tourne 24/7 (ton VPS). L'EA interroge l'app, place les ordres acceptés, gère la
position (break-even à TP1 puis trailing) et renvoie chaque évènement.

```
App SnapTrade AI (Railway)
   │   GET  /api/bridge/pending      ← l'EA réclame les ordres "Acceptés"
   │   POST /api/bridge/report       → filled / rejected / be_moved / trailing / closed
   │   POST /api/bridge/heartbeat    → équité, positions, kill-switch
   ▼
SnapTradeBridge.mq5  (dans MT5, sur le VPS)
   ▼
Compte MT5 (démo d'abord)
```

## 1. Base de données

Applique la migration `supabase/migrations/20260827000002_order_execution.sql`
(Supabase Studio → SQL Editor, ou `supabase db push`). Elle crée `orders`,
`bridge_accounts` et la fonction `claim_pending_orders`.

## 2. Variables serveur (Railway)

```bash
railway variables --set BRIDGE_TOKEN=$(openssl rand -hex 24)
# ADMIN_TOKEN doit aussi être défini (voir .env.example)
```

Récupère la valeur générée : `railway variables | grep BRIDGE_TOKEN`

## 3. Installer l'EA

1. Copie `SnapTradeBridge.mq5` dans `MQL5/Experts/` du terminal (via
   MetaEditor : Fichier → Ouvrir le dossier de données).
2. Compile (F7). Corrige les éventuelles erreurs de build et recompile.
3. Terminal → Outils → Options → Expert Advisors :
   - coche **Autoriser le trading algorithmique**
   - coche **Autoriser les WebRequest pour les URL listées**
   - ajoute `https://snaptrade-ai-production.up.railway.app`
4. Glisse l'EA sur **un seul** graphique (n'importe quel symbole ; l'EA ouvre
   lui-même le bon symbole). Active « Trading algo ».

## 4. Réglages de l'EA (inputs)

| Input | Défaut | Rôle |
|---|---|---|
| `ApiBase` | URL Railway | à laisser tel quel |
| `BridgeToken` | — | **colle le `BRIDGE_TOKEN`** |
| `AccountLabel` | `VPS-1` | nom affiché dans la console admin |
| `PollSeconds` | `3` | fréquence d'interrogation |
| `RiskPercent` | `1.0` | recalcul du lot sur l'équité réelle (`0` = lot envoyé par l'app) |
| `MaxSpreadPoints` | `40` | refuse l'ordre si spread trop large |
| `SymbolSuffix` | `""` | ex `.r` si ton courtier nomme `XAUUSD.r` |
| `EntryToleranceR` | `0.25` | marché si le prix est proche de l'entrée, sinon ordre limite |
| `BE_AtTP1` | `true` | SL → break-even quand TP1 est touché |
| `Trailing` | `true` | après le BE, SL suiveur = `TrailATRmult × ATR` |
| `TrailATRmult` | `1.5` | (fallback = distance 1R si l'ATR est absent) |
| `AllowLive` | `false` | **garde-fou** : reste `false` tant que tu testes en démo |
| `MaxOpenPositions` | `1` | |
| `MaxDailyLossPct` | `5.0` | stoppe les nouveaux ordres après -5 % sur la journée |

## 5. Cycle de vie d'un ordre

1. Scan → signal → tu cliques **Accepter** (plateforme « MetaTrader 5 — Démo »).
2. L'app crée une ligne `orders` `pending` avec une réf `STO-XXXXXX`.
3. L'EA la réclame (→ `claimed`), place l'ordre (marché ou limite), pose SL + TP
   (TP = TP2 comme plafond), renvoie `filled` + le ticket.
4. Quand le prix touche **TP1** → SL remonte à l'entrée (`be_moved`).
5. Ensuite le SL **suit** le prix à `1.5 × ATR` et ne recule jamais (`trailing`).
6. À la fermeture → `closed` avec le P&L. Tout est visible dans `/admin`.

## 6. Arrêt d'urgence

- Console `/admin` → section « Ponts MT5 » → (kill-switch par compte via
  `POST /api/admin/kill-switch`).
- Ou simplement retirer l'EA du graphique / couper « Trading algo ».

## 7. Passage au réel (plus tard)

1. Des semaines de démo concluantes d'abord.
2. `bridge_accounts.live_enabled = true` pour ce compte (SQL).
3. Input EA `AllowLive = true` sur un terminal connecté au compte réel.
4. Dans l'app, l'option « MetaTrader 5 — RÉEL » n'apparaît que si un
   `st_admin_token` est présent dans le navigateur (localStorage).
