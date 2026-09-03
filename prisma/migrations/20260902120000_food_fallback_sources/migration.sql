-- Additional external food data sources for the UPC/search fallback chain.
-- Additive enum change: no existing rows are affected.
ALTER TYPE "FoodSource" ADD VALUE IF NOT EXISTS 'nutritionix';
ALTER TYPE "FoodSource" ADD VALUE IF NOT EXISTS 'edamam';
