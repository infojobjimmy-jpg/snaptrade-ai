//+------------------------------------------------------------------+
//|                                            SnapTradeBridge.mq5    |
//|   Pont d'exécution entre l'app SnapTrade AI et ce terminal MT5.   |
//|                                                                  |
//|   - Interroge  GET  {ApiBase}/api/bridge/pending  toutes les      |
//|     PollSeconds, place les ordres acceptés dans l'app.            |
//|   - Une seule position par signal.                               |
//|   - Break-even : quand le prix touche TP1, le SL remonte à        |
//|     l'entrée (+ buffer). Puis trailing stop = TrailATRmult x ATR. |
//|     Le SL ne recule jamais.                                       |
//|   - Renvoie chaque évènement à  POST {ApiBase}/api/bridge/report. |
//|                                                                  |
//|   AVANT UTILISATION :                                            |
//|   Outils > Options > Expert Advisors > cocher « Autoriser les     |
//|   WebRequest » et ajouter l'URL de ApiBase (ex:                   |
//|   https://snaptrade-ai-production.up.railway.app).                |
//|                                                                  |
//|   Teste d'abord sur COMPTE DÉMO. AllowLive reste false par défaut.|
//+------------------------------------------------------------------+
#property copyright "SnapTrade AI"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- Connexion -----------------------------------------------------
input string  ApiBase           = "https://snaptrade-ai-production.up.railway.app";
input string  BridgeToken       = "";              // = BRIDGE_TOKEN côté serveur
input string  AccountLabel      = "VPS-1";
input int     PollSeconds       = 3;

//--- Risque / exécution ------------------------------------------
input double  RiskPercent       = 1.0;             // 0 = utiliser le lot envoyé par l'app
input double  FixedLotFallback  = 0.01;
input int     MaxSpreadPoints   = 40;
input int     SlippagePoints    = 20;
input int     MagicNumber       = 770077;
input string  SymbolSuffix      = "";              // ex: ".r" si ton courtier nomme XAUUSD.r
input string  SymbolOverride    = "";              // force un symbole unique (sinon celui du signal)
input double  EntryToleranceR   = 0.25;            // marché si prix à < 0.25 x (entry-SL), sinon ordre limite
input int     PendingExpiryMin  = 60;

//--- Gestion de position ---------------------------------------
input bool    BE_AtTP1          = true;
input int     BE_BufferPoints   = 2;
input bool    Trailing          = true;
input double  TrailATRmult      = 1.5;
input int     TrailMinStepPoints= 5;

//--- Garde-fous ------------------------------------------------
input bool    AllowLive         = false;           // doit être true ET compte réel pour trader en réel
input int     MaxOpenPositions  = 1;
input double  MaxDailyLossPct    = 5.0;

//--- État -----------------------------------------------------------
CTrade   trade;
datetime g_lastPoll   = 0;
datetime g_lastBeat   = 0;
bool     g_killSwitch = false;
bool     g_liveOk     = false;
double   g_dayStartEquity = 0;
datetime g_dayStamp   = 0;

struct Managed
{
   string   ref;
   ulong    ticket;
   int      dir;        // +1 buy, -1 sell
   double   entry, sl, tp1, tp2, atr;
   bool     be_moved;
};
Managed  g_pos[];

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   ENUM_ACCOUNT_TRADE_MODE m = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   g_liveOk = (m != ACCOUNT_TRADE_MODE_REAL) || AllowLive;
   if(m == ACCOUNT_TRADE_MODE_REAL && !AllowLive)
      Print("SnapTradeBridge: COMPTE RÉEL détecté et AllowLive=false → gestion des positions seulement, aucun nouvel ordre.");

   if(StringLen(BridgeToken) < 8)
      Print("SnapTradeBridge: BridgeToken vide ou trop court — configure-le.");

   RebuildFromOpenPositions();
   ResetDayAnchor();

   EventSetTimer(MathMax(1, PollSeconds));
   Print("SnapTradeBridge prêt — compte ", AccountInfoInteger(ACCOUNT_LOGIN),
         " (", EnumToString(m), "), positions suivies: ", ArraySize(g_pos));
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
void OnTimer()
{
   ResetDayAnchor();
   if(TimeCurrent() - g_lastBeat >= 15) { SendHeartbeat(); g_lastBeat = TimeCurrent(); }
   if(TimeCurrent() - g_lastPoll >= PollSeconds) { PollPending(); g_lastPoll = TimeCurrent(); }
   ManageAll();
}

void OnTick() { ManageAll(); }

//+------------------------------------------------------------------+
//| HTTP helpers                                                      |
//+------------------------------------------------------------------+
bool HttpJson(const string method, const string url, const string body, string &out)
{
   char post[]; char result[]; string rh;
   if(StringLen(body) > 0) StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + BridgeToken + "\r\n";
   ResetLastError();
   int code = WebRequest(method, url, headers, 8000, post, result, rh);
   if(code == -1)
   {
      int err = GetLastError();
      if(err == 4014)
         Print("WebRequest interdit. Ajoute ", ApiBase,
               " dans Outils>Options>Expert Advisors>Autoriser WebRequest.");
      else
         Print("WebRequest échec ", method, " ", url, " err=", err);
      return(false);
   }
   out = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code >= 300)
   {
      Print("HTTP ", code, " sur ", url, " → ", StringSubstr(out, 0, 200));
      return(false);
   }
   return(true);
}

//+------------------------------------------------------------------+
//| Mini extraction JSON (structures contrôlées par notre serveur)    |
//+------------------------------------------------------------------+
string JGetStr(const string js, const string key)
{
   int p = StringFind(js, "\"" + key + "\"");
   if(p < 0) return("");
   p = StringFind(js, ":", p); if(p < 0) return("");
   p++;
   while(p < StringLen(js) && (StringGetCharacter(js, p) == ' ' || StringGetCharacter(js, p) == '\t')) p++;
   if(p >= StringLen(js)) return("");
   ushort c = StringGetCharacter(js, p);
   if(c == '"')
   {
      int e = StringFind(js, "\"", p + 1);
      if(e < 0) return("");
      return(StringSubstr(js, p + 1, e - p - 1));
   }
   int e = p;
   while(e < StringLen(js))
   {
      ushort ch = StringGetCharacter(js, e);
      if(ch == ',' || ch == '}' || ch == ']' || ch == ' ') break;
      e++;
   }
   return(StringSubstr(js, p, e - p));
}
double JGetNum(const string js, const string key)
{
   string s = JGetStr(js, key);
   if(s == "" || s == "null") return(0);
   return(StringToDouble(s));
}
bool JGetBool(const string js, const string key) { return(JGetStr(js, key) == "true"); }

// Découpe le tableau "orders":[ {..},{..} ] en objets individuels
int SplitOrders(const string js, string &objs[])
{
   ArrayResize(objs, 0);
   int a = StringFind(js, "\"orders\"");
   if(a < 0) return(0);
   a = StringFind(js, "[", a);
   if(a < 0) return(0);
   int depth = 0, start = -1, n = StringLen(js);
   for(int i = a; i < n; i++)
   {
      ushort c = StringGetCharacter(js, i);
      if(c == '{') { if(depth == 0) start = i; depth++; }
      else if(c == '}') { depth--; if(depth == 0 && start >= 0) { int sz = ArraySize(objs); ArrayResize(objs, sz + 1); objs[sz] = StringSubstr(js, start, i - start + 1); start = -1; } }
      else if(c == ']' && depth == 0) break;
   }
   return(ArraySize(objs));
}

//+------------------------------------------------------------------+
string BrokerSymbol(const string sig)
{
   if(SymbolOverride != "") return(SymbolOverride);
   string s = sig;
   if(SymbolSelect(s, true)) return(s);
   if(SymbolSuffix != "" && SymbolSelect(s + SymbolSuffix, true)) return(s + SymbolSuffix);
   // essais courants
   string alt[] = {"XAUUSD", "GOLD", "XAUUSD.", "US30", "USTEC", "NAS100"};
   if(SymbolSelect(s, true)) return(s);
   return(s); // laissera OrderSend échouer proprement si introuvable
}

double CalcLot(const string sym, double entry, double sl, double appLot)
{
   if(RiskPercent <= 0) return(NormalizeLot(sym, appLot > 0 ? appLot : FixedLotFallback));
   double slDist = MathAbs(entry - sl);
   double tickVal = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   if(slDist <= 0 || tickVal <= 0 || tickSize <= 0) return(NormalizeLot(sym, FixedLotFallback));
   double lossPerLot = slDist / tickSize * tickVal;
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double lot = (equity * RiskPercent / 100.0) / lossPerLot;
   return(NormalizeLot(sym, lot));
}
double NormalizeLot(const string sym, double lot)
{
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double mn = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double mx = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(step <= 0) step = 0.01;
   lot = MathFloor(lot / step) * step;
   if(lot < mn) lot = mn;
   if(lot > mx) lot = mx;
   return(NormalizeDouble(lot, 2));
}

//+------------------------------------------------------------------+
int CountOurPositions()
{
   int c = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(PositionSelectByTicket(t) && PositionGetInteger(POSITION_MAGIC) == MagicNumber) c++;
   }
   return(c);
}

void ResetDayAnchor()
{
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   datetime day = StringToTime(StringFormat("%04d.%02d.%02d", dt.year, dt.mon, dt.day));
   if(day != g_dayStamp) { g_dayStamp = day; g_dayStartEquity = AccountInfoDouble(ACCOUNT_BALANCE); }
}
bool DailyLossHit()
{
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(g_dayStartEquity <= 0) return(false);
   double ddPct = (g_dayStartEquity - eq) / g_dayStartEquity * 100.0;
   return(ddPct >= MaxDailyLossPct);
}

//+------------------------------------------------------------------+
void SendHeartbeat()
{
   ENUM_ACCOUNT_TRADE_MODE m = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string atype = (m == ACCOUNT_TRADE_MODE_REAL) ? "real" : (m == ACCOUNT_TRADE_MODE_CONTEST ? "contest" : "demo");
   string body = StringFormat(
      "{\"account_id\":\"%I64d\",\"label\":\"%s\",\"account_type\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"open_positions\":%d,\"terminal_build\":%d}",
      AccountInfoInteger(ACCOUNT_LOGIN), AccountLabel, atype,
      AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY),
      CountOurPositions(), TerminalInfoInteger(TERMINAL_BUILD));
   string out;
   if(HttpJson("POST", ApiBase + "/api/bridge/heartbeat", body, out))
      g_killSwitch = JGetBool(out, "kill_switch");
}

void Report(const string ref, const string event, ulong ticket, double price, double pnl, const string msg)
{
   string body = StringFormat("{\"ref\":\"%s\",\"event\":\"%s\",\"mt5_ticket\":%I64u,\"price\":%.5f,\"pnl\":%.2f,\"message\":\"%s\"}",
                              ref, event, ticket, price, pnl, msg);
   string out;
   HttpJson("POST", ApiBase + "/api/bridge/report", body, out);
}

//+------------------------------------------------------------------+
void PollPending()
{
   if(!g_liveOk) return;
   string url = StringFormat("%s/api/bridge/pending?account_id=%I64d", ApiBase, AccountInfoInteger(ACCOUNT_LOGIN));
   string out;
   if(!HttpJson("GET", url, "", out)) return;

   string objs[];
   int n = SplitOrders(out, objs);
   for(int i = 0; i < n; i++)
      ProcessOrder(objs[i]);
}

void ProcessOrder(const string o)
{
   string ref = JGetStr(o, "ref");
   string sig = JGetStr(o, "symbol");
   string dir = JGetStr(o, "direction");
   double entry = JGetNum(o, "entry"), sl = JGetNum(o, "sl");
   double tp1 = JGetNum(o, "tp1"), tp2 = JGetNum(o, "tp2");
   double atr = JGetNum(o, "atr");
   double appLot = JGetNum(o, "lot");
   if(ref == "" || sig == "" || entry <= 0 || sl <= 0) { Report(ref, "rejected", 0, 0, 0, "Payload incomplet"); return; }

   if(g_killSwitch)                       { Report(ref, "rejected", 0, 0, 0, "Kill-switch actif"); return; }
   if(DailyLossHit())                     { Report(ref, "rejected", 0, 0, 0, "Perte journalière max atteinte"); return; }
   if(CountOurPositions() >= MaxOpenPositions) { Report(ref, "rejected", 0, 0, 0, "Nombre de positions max atteint"); return; }
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
                                          { Report(ref, "rejected", 0, 0, 0, "Trading désactivé dans le terminal"); return; }

   string sym = BrokerSymbol(sig);
   if(!SymbolSelect(sym, true))           { Report(ref, "rejected", 0, 0, 0, "Symbole introuvable: " + sig); return; }

   long spread = SymbolInfoInteger(sym, SYMBOL_SPREAD);
   if(spread > MaxSpreadPoints)           { Report(ref, "rejected", 0, 0, 0, StringFormat("Spread %d > max %d", (int)spread, MaxSpreadPoints)); return; }

   int d = (dir == "buy") ? 1 : -1;
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double px  = (d > 0) ? ask : bid;
   double R   = MathAbs(entry - sl);
   double lot = CalcLot(sym, entry, sl, appLot);
   double hardTP = tp2 > 0 ? tp2 : 0;

   trade.SetTypeFillingBySymbol(sym);
   bool market = MathAbs(px - entry) <= EntryToleranceR * R;
   bool ok = false;

   if(market)
   {
      ok = (d > 0) ? trade.Buy(lot, sym, 0.0, sl, hardTP, ref)
                   : trade.Sell(lot, sym, 0.0, sl, hardTP, ref);
   }
   else
   {
      datetime exp = TimeCurrent() + PendingExpiryMin * 60;
      if(d > 0)
         ok = trade.BuyLimit(lot, entry, sym, sl, hardTP, ORDER_TIME_SPECIFIED, exp, ref);
      else
         ok = trade.SellLimit(lot, entry, sym, sl, hardTP, ORDER_TIME_SPECIFIED, exp, ref);
   }

   if(!ok)
   {
      Report(ref, "rejected", 0, 0, 0, StringFormat("OrderSend %d %s", trade.ResultRetcode(), trade.ResultRetcodeDescription()));
      return;
   }

   if(market)
   {
      ulong ticket = trade.ResultOrder();
      // retrouver la position ouverte
      ulong posTicket = 0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong t = PositionGetTicket(i);
         if(PositionSelectByTicket(t) && PositionGetString(POSITION_COMMENT) == ref) { posTicket = t; break; }
      }
      double fill = trade.ResultPrice();
      Report(ref, "filled", posTicket, fill, 0, market ? "Marché" : "Limite");
      Track(ref, posTicket, d, entry, sl, tp1, tp2, atr);
   }
   else
   {
      Report(ref, "filled", trade.ResultOrder(), entry, 0, "Ordre limite posé");
      // sera suivi quand il se transforme en position (via RebuildFromOpenPositions au tick)
   }
}

//+------------------------------------------------------------------+
void Track(const string ref, ulong ticket, int d, double entry, double sl, double tp1, double tp2, double atr)
{
   for(int i = 0; i < ArraySize(g_pos); i++) if(g_pos[i].ref == ref) return;
   int n = ArraySize(g_pos); ArrayResize(g_pos, n + 1);
   g_pos[n].ref = ref; g_pos[n].ticket = ticket; g_pos[n].dir = d;
   g_pos[n].entry = entry; g_pos[n].sl = sl; g_pos[n].tp1 = tp1; g_pos[n].tp2 = tp2; g_pos[n].atr = atr;
   g_pos[n].be_moved = false;
}

void RebuildFromOpenPositions()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(!PositionSelectByTicket(t)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      string ref = PositionGetString(POSITION_COMMENT);
      if(ref == "") continue;
      bool known = false;
      for(int k = 0; k < ArraySize(g_pos); k++) if(g_pos[k].ref == ref) { known = true; break; }
      if(known) continue;
      int d = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 1 : -1;
      double entry = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl = PositionGetDouble(POSITION_SL);
      // TP1/TP2/ATR inconnus après redémarrage : on repart de la position telle quelle,
      // be_moved déduit si le SL est déjà au niveau de l'entrée
      Track(ref, t, d, entry, sl, 0, 0, 0);
      int idx = ArraySize(g_pos) - 1;
      g_pos[idx].be_moved = (d > 0) ? (sl >= entry) : (sl > 0 && sl <= entry);
   }
}

//+------------------------------------------------------------------+
void ManageAll()
{
   RebuildFromOpenPositions();
   for(int i = ArraySize(g_pos) - 1; i >= 0; i--)
   {
      if(!PositionSelectByTicket(g_pos[i].ticket))
      {
         // position fermée → rapporter avec P&L depuis l'historique
         double pnl = 0, closePx = 0;
         if(HistorySelectByPosition(g_pos[i].ticket))
         {
            for(int k = HistoryDealsTotal() - 1; k >= 0; k--)
            {
               ulong dticket = HistoryDealGetTicket(k);
               if(HistoryDealGetInteger(dticket, DEAL_POSITION_ID) != (long)g_pos[i].ticket) continue;
               pnl += HistoryDealGetDouble(dticket, DEAL_PROFIT) + HistoryDealGetDouble(dticket, DEAL_SWAP) + HistoryDealGetDouble(dticket, DEAL_COMMISSION);
               if(HistoryDealGetInteger(dticket, DEAL_ENTRY) == DEAL_ENTRY_OUT) closePx = HistoryDealGetDouble(dticket, DEAL_PRICE);
            }
         }
         Report(g_pos[i].ref, "closed", g_pos[i].ticket, closePx, pnl, "Position fermée");
         ArrayRemove(g_pos, i, 1);
         continue;
      }
      ManageOne(i);
   }
}

void ManageOne(int i)
{
   string sym = PositionGetString(POSITION_SYMBOL);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double curSL = PositionGetDouble(POSITION_SL);
   double curTP = PositionGetDouble(POSITION_TP);
   double entry = g_pos[i].entry;
   int d = g_pos[i].dir;
   double buf = BE_BufferPoints * point;

   // 1) Break-even quand TP1 est touché
   if(BE_AtTP1 && !g_pos[i].be_moved && g_pos[i].tp1 > 0)
   {
      bool hit = (d > 0) ? (bid >= g_pos[i].tp1) : (ask <= g_pos[i].tp1);
      if(hit)
      {
         double newSL = (d > 0) ? entry + buf : entry - buf;
         if((d > 0 && newSL > curSL) || (d < 0 && (curSL == 0 || newSL < curSL)))
         {
            if(trade.PositionModify(g_pos[i].ticket, newSL, curTP))
            {
               g_pos[i].be_moved = true;
               Report(g_pos[i].ref, "be_moved", g_pos[i].ticket, newSL, 0, "SL au break-even");
            }
         }
         else g_pos[i].be_moved = true;
      }
   }

   // 2) Trailing après le break-even
   if(Trailing && g_pos[i].be_moved)
   {
      double dist = (g_pos[i].atr > 0) ? g_pos[i].atr * TrailATRmult
                                       : MathAbs(entry - g_pos[i].sl); // fallback = 1R
      if(dist <= 0) return;
      double minStep = TrailMinStepPoints * point;
      if(d > 0)
      {
         double newSL = bid - dist;
         if(newSL > curSL + minStep && newSL > entry)
            if(trade.PositionModify(g_pos[i].ticket, NormalizeDouble(newSL, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS)), curTP))
               Report(g_pos[i].ref, "trailing", g_pos[i].ticket, newSL, 0, "SL suiveur");
      }
      else
      {
         double newSL = ask + dist;
         if((curSL == 0 || newSL < curSL - minStep) && newSL < entry)
            if(trade.PositionModify(g_pos[i].ticket, NormalizeDouble(newSL, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS)), curTP))
               Report(g_pos[i].ref, "trailing", g_pos[i].ticket, newSL, 0, "SL suiveur");
      }
   }
}
//+------------------------------------------------------------------+
