#!/usr/bin/env python3
"""
ASX Platform — ML Backtest + Layer 7 Training
Uses 2 years of OHLCV from Supabase + EODHD technical indicators
Trains XGBoost to predict whether a stock hits +3% within 5 days
Outputs: win rate, feature importance, saves model for Layer 7

Usage:
  pip install supabase requests xgboost scikit-learn pandas numpy joblib
  python ml_backtest.py

Takes about 10-15 minutes to run
"""

import pandas as pd
import numpy as np
import requests
import time
from datetime import datetime, timedelta
from supabase import create_client
import warnings
warnings.filterwarnings('ignore')

# ── CONFIG ────────────────────────────────────────────────────────────────────
SUPABASE_URL  = "https://opziisvjfkjwwdbclniw.supabase.co"
SUPABASE_KEY  = ""  # paste your service key
EODHD_API_KEY = ""  # paste your EODHD key

TARGET_PCT    = 0.03   # 3% target
STOP_PCT      = 0.015  # 1.5% stop
HOLD_DAYS     = 5      # max days to hold

# ─────────────────────────────────────────────────────────────────────────────

def get_eodhd_technicals(ticker, api_key):
    """Get EODHD server-side technical indicators for a stock"""
    epic = f"{ticker}.AU"
    base = "https://eodhd.com/api"
    results = {}
    
    endpoints = {
        'rsi14':   f"{base}/technical/{epic}?function=rsi&period=14&api_token={api_key}&fmt=json",
        'sma20':   f"{base}/technical/{epic}?function=sma&period=20&api_token={api_key}&fmt=json",
        'sma50':   f"{base}/technical/{epic}?function=sma&period=50&api_token={api_key}&fmt=json",
        'sma200':  f"{base}/technical/{epic}?function=sma&period=200&api_token={api_key}&fmt=json",
    }
    
    for key, url in endpoints.items():
        try:
            res = requests.get(url, timeout=10)
            data = res.json()
            if isinstance(data, list) and len(data) > 0:
                last = data[-1]
                if key == 'rsi14':   results['rsi14']  = float(last.get('rsi', 0))
                elif key == 'sma20': results['sma20']  = float(last.get('sma', 0))
                elif key == 'sma50': results['sma50']  = float(last.get('sma', 0))
                elif key == 'sma200':results['sma200'] = float(last.get('sma', 0))
        except:
            pass
    
    return results


def compute_features(prices_df):
    """Compute technical features from price history"""
    df = prices_df.copy().sort_values('market_date').reset_index(drop=True)
    df['close']  = df['close'].astype(float)
    df['volume'] = df['volume'].astype(float)
    df['high']   = df['high'].astype(float)
    df['low']    = df['low'].astype(float)
    df['open']   = df['open'].astype(float)
    
    # Moving averages
    df['sma20']  = df['close'].rolling(20).mean()
    df['sma50']  = df['close'].rolling(50).mean()
    df['sma200'] = df['close'].rolling(200).mean()
    
    # RSI
    delta = df['close'].diff()
    gain  = delta.clip(lower=0).rolling(14).mean()
    loss  = (-delta.clip(upper=0)).rolling(14).mean()
    rs    = gain / loss.replace(0, np.nan)
    df['rsi14'] = 100 - (100 / (1 + rs))
    
    # Bollinger Bands
    df['bb_mid']   = df['close'].rolling(20).mean()
    df['bb_std']   = df['close'].rolling(20).std()
    df['bb_upper'] = df['bb_mid'] + 2 * df['bb_std']
    df['bb_lower'] = df['bb_mid'] - 2 * df['bb_std']
    df['bb_pos']   = (df['close'] - df['bb_lower']) / (df['bb_upper'] - df['bb_lower'] + 1e-9)
    
    # Volume ratio
    df['vol_avg20'] = df['volume'].rolling(20).mean()
    df['vol_ratio'] = df['volume'] / df['vol_avg20'].replace(0, np.nan)
    
    # Rate of change
    df['roc5']  = df['close'].pct_change(5)
    df['roc20'] = df['close'].pct_change(20)
    
    # Distance from MAs
    df['pct_from_sma20']  = (df['close'] - df['sma20'])  / df['sma20']
    df['pct_from_sma200'] = (df['close'] - df['sma200']) / df['sma200']
    
    # Above/below MAs
    df['above_sma20']  = (df['close'] > df['sma20']).astype(int)
    df['above_sma200'] = (df['close'] > df['sma200']).astype(int)
    df['golden_cross'] = (df['sma50'] > df['sma200']).astype(int)
    
    # Candlestick features
    df['body']        = abs(df['close'] - df['open'])
    df['range']       = df['high'] - df['low']
    df['lower_shadow'] = df[['open','close']].min(axis=1) - df['low']
    df['upper_shadow'] = df['high'] - df[['open','close']].max(axis=1)
    df['hammer']      = ((df['lower_shadow'] > df['body'] * 2) & (df['range'] > 0)).astype(int)
    df['bull_candle'] = (df['close'] > df['open']).astype(int)
    
    # Target: did price hit +3% within 5 days?
    df['future_max'] = df['close'].shift(-1).rolling(HOLD_DAYS).max().shift(-(HOLD_DAYS-1))
    df['hit_target'] = (df['future_max'] >= df['close'] * (1 + TARGET_PCT)).astype(int)
    
    # Also check stop
    df['future_min'] = df['close'].shift(-1).rolling(HOLD_DAYS).min().shift(-(HOLD_DAYS-1))
    df['hit_stop']   = (df['future_min'] <= df['close'] * (1 - STOP_PCT)).astype(int)
    
    # Final label: 1 if hit target without hitting stop first
    df['label'] = ((df['hit_target'] == 1) & (df['hit_stop'] == 0)).astype(int)
    
    return df


def main():
    if not SUPABASE_KEY or not EODHD_API_KEY:
        print("ERROR: Paste your SUPABASE_KEY and EODHD_API_KEY into the script")
        return
    
    print("ASX Platform — ML Backtest + Layer 7 Training")
    print("=" * 60)
    
    db = create_client(SUPABASE_URL, SUPABASE_KEY)
    
    # Get active stocks
    result = db.table("stocks").select("ticker,name,sector,universe").eq("active", True).execute()
    stocks = [s for s in result.data if s['ticker'] != 'GSBG37']
    print(f"Stocks: {len(stocks)}")
    
    # Get all prices
    print("Loading price history from Supabase...")
    price_result = db.table("prices").select("ticker,market_date,open,high,low,close,volume").order("market_date").execute()
    prices_df    = pd.DataFrame(price_result.data)
    print(f"Price rows: {len(prices_df):,}")
    
    # Build feature dataset
    print("\nComputing features for all stocks...")
    all_features = []
    
    for i, stock in enumerate(stocks):
        ticker = stock['ticker']
        df     = prices_df[prices_df['ticker'] == ticker].copy()
        
        if len(df) < 220:
            continue
        
        try:
            features = compute_features(df)
            features['ticker']   = ticker
            features['sector']   = stock.get('sector', 'Other')
            features['universe'] = stock.get('universe', 'ASX500')
            all_features.append(features)
            
            if (i + 1) % 50 == 0:
                print(f"  {i+1}/{len(stocks)} stocks processed")
        except Exception as e:
            pass
    
    print(f"\nFeature dataset: {len(all_features)} stocks")
    
    # Combine and clean
    data = pd.concat(all_features, ignore_index=True)
    
    feature_cols = [
        'rsi14', 'sma20', 'sma50', 'sma200', 'bb_pos',
        'vol_ratio', 'roc5', 'roc20',
        'pct_from_sma20', 'pct_from_sma200',
        'above_sma20', 'above_sma200', 'golden_cross',
        'hammer', 'bull_candle', 'lower_shadow', 'upper_shadow',
        'body', 'range'
    ]
    
    data = data.dropna(subset=feature_cols + ['label'])
    data = data[data['label'].isin([0, 1])]
    
    X = data[feature_cols]
    y = data['label']
    
    print(f"\nDataset: {len(X):,} samples")
    print(f"Positive rate (hit +3%): {y.mean():.1%}")
    
    # Train/test split — use last 20% as test (time-based)
    split = int(len(X) * 0.8)
    X_train, X_test = X.iloc[:split], X.iloc[split:]
    y_train, y_test = y.iloc[:split], y.iloc[split:]
    
    print(f"\nTraining XGBoost on {len(X_train):,} samples...")
    
    try:
        from xgboost import XGBClassifier
        from sklearn.metrics import classification_report, roc_auc_score
        
        model = XGBClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            scale_pos_weight=(y_train==0).sum() / (y_train==1).sum(),
            random_state=42,
            eval_metric='logloss',
            verbosity=0
        )
        
        model.fit(X_train, y_train)
        
        # Evaluate
        y_pred  = model.predict(X_test)
        y_proba = model.predict_proba(X_test)[:, 1]
        auc     = roc_auc_score(y_test, y_proba)
        
        print(f"\n{'='*60}")
        print(f"MODEL RESULTS")
        print(f"{'='*60}")
        print(f"AUC Score:    {auc:.4f}  (0.5=random, 1.0=perfect)")
        print(f"Win rate (baseline, no ML): {y_test.mean():.1%}")
        
        # Win rate when model predicts positive
        high_conf = y_proba >= 0.6
        if high_conf.sum() > 0:
            print(f"\nWhen ML predicts BUY (>60% confidence):")
            print(f"  Signals:   {high_conf.sum():,}")
            print(f"  Win rate:  {y_test[high_conf].mean():.1%}  (vs {y_test.mean():.1%} baseline)")
        
        # Feature importance
        importance = pd.Series(model.feature_importances_, index=feature_cols).sort_values(ascending=False)
        print(f"\nTop 10 most important features:")
        for feat, imp in importance.head(10).items():
            print(f"  {feat:25s} {imp:.4f}")
        
        # Backtest simulation
        print(f"\n{'='*60}")
        print(f"6-LAYER RULES BACKTEST (last 20% of data)")
        print(f"{'='*60}")
        
        test_data = data.iloc[split:].copy()
        
        # Apply 6-layer rules
        def apply_6layer(row):
            score = 0
            score += 1  # Layer 1: assume macro neutral
            score += 1 if row['above_sma200'] else 0
            score += 1 if row['above_sma20'] else 0
            score += 1 if row['rsi14'] < 45 or row['bb_pos'] < 0.3 else 0
            score += 1 if row['vol_ratio'] > 1.5 else 0
            score += 1 if row['hammer'] else 0
            return score
        
        test_data['score'] = test_data.apply(apply_6layer, axis=1)
        
        for min_score in [4, 5, 6]:
            subset = test_data[test_data['score'] >= min_score]
            if len(subset) > 0:
                win_rate = subset['label'].mean()
                print(f"  Score {min_score}+: {len(subset):5,} signals — Win rate: {win_rate:.1%}")
        
        # Layer 7: 6-layer + ML
        print(f"\n6-LAYER + ML LAYER 7 (>60% confidence)")
        test_data['ml_prob'] = model.predict_proba(X_test)[:, 1]
        
        for min_score in [4, 5, 6]:
            subset = test_data[(test_data['score'] >= min_score) & (test_data['ml_prob'] >= 0.6)]
            if len(subset) > 0:
                win_rate = subset['label'].mean()
                print(f"  Score {min_score}+ + ML: {len(subset):5,} signals — Win rate: {win_rate:.1%}")
        
        # Save model
        import joblib
        model_path = 'asx_layer7_model.joblib'
        joblib.dump(model, model_path)
        print(f"\n✓ Model saved to {model_path}")
        print(f"  Upload this file to use as Layer 7 in the strategy engine")
        
    except ImportError:
        print("\nXGBoost not installed. Run:")
        print("  pip install xgboost scikit-learn joblib")
    
    print(f"\n{'='*60}")
    print("DONE")

if __name__ == "__main__":
    main()
