-- Backlog #58 V3 follow-up — shipping cost backfill on sale orders.
--
-- Sources (per Huayi, 2026-06-05, files in repo root):
--   • LILA customer fulfillment-20260605.xlsx
--       — Canada Shipping  (carrier label cost)
--       — US Shipping      (carrier label cost)
--       — Personal Delivery (no price → flat $60 CAD: $20 gas + $40 labor for ~1hr)
--   • LILA customer shipping via MaxxUs.xlsx
--       — Ship Out  (older orders pre-2026-Jan, "$XX.XX CAD" string-format prices)
--
-- Matched 70 of 82 DB orders by case-insensitive normalized customer name
-- (with shipping totals summed across multiple rows per customer, and
-- split evenly when one customer name maps to multiple orders).
-- The remaining 12 DB orders had no matching shipping row in either xlsx —
-- a separate question (probably ship hadn't been recorded at extract time).
--
-- 97 spreadsheet rows are for customer names NOT in the orders table
-- (Shopify-sync coverage gap) — captured in a separate backlog item.
--
-- Idempotency: each statement is gated on shipping_cost_usd IS NULL so
-- replays are no-ops. Manually-entered values are preserved.

begin;
  update public.orders set shipping_cost_usd = 79.47  where id = 'feb45f39-69ed-47b2-9d10-72439b2fe1ae' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 274.24 where id = '6db8d465-b9c7-42d7-a93c-dea108fc867b' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 79.47  where id = '0d1bda9e-d488-40a8-a660-079ae33b3e8d' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 75.49  where id = '393f8dd0-c5bb-4b87-b666-3ae3fea678a2' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 58.26  where id = '6f7f590d-3922-4a58-b67d-3c701d0096a2' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 62.25  where id = 'dd821102-a97f-48fd-9cc5-a8de33037b69' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 58.00  where id = '0fc2a337-a8ce-45bd-b1ed-7dbef0b2537f' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 65.19  where id = 'dfebbcd0-ef02-44fe-9789-959362437543' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 58.00  where id = 'b5c9738e-7ace-408b-991e-ba60e61f6472' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 76.15  where id = '03c0b5a3-884a-4cdd-a821-195abc74f517' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 43.55  where id = '1392db84-5245-42dc-8e07-04e17e38d03c' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 43.55  where id = '45524a86-d1a5-49dc-a9d6-f8c300fba151' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 55.69  where id = 'f64b14cb-0690-4fac-b78f-256dd1bb2a90' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 73.67  where id = 'd873b1b0-028a-4cd7-aadc-3cb8ea015ccd' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 77.31  where id = 'ae9d5565-200b-4745-a3d8-efc9f29e8e82' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 82.33  where id = '262a01a3-fb72-43cf-afeb-bba49c315c07' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 71.06  where id = 'd151e0b2-d0bf-448a-98dc-99a251dfed69' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 76.91  where id = 'b2a45c58-2424-49b2-aecd-20c482f42637' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 76.91  where id = 'a0025f60-471d-4d1e-af1f-89cd4b5ec76f' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 95.58  where id = 'ea04c387-278f-4854-bb3e-6cd57b601eac' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 92.65  where id = '29efb596-4296-452a-9b6d-a3b8b898d8b7' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 108.81 where id = '17c3098c-a9aa-47a6-9bab-505c4f63cd88' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 93.38  where id = 'c00bc625-7b98-42ba-b7bd-ca006aa9eb26' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 107.04 where id = '046b3feb-9218-4d3a-b9dd-25cacf0d17e7' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 61.44  where id = '9c906c7c-cd3b-4fe7-acbe-a74be8697c75' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 95.23  where id = '7caaae01-5739-479a-86f5-9d8003bef5b2' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 113.31 where id = '8022e9a6-9541-4321-9272-76d0394ad4fe' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 133.92 where id = '5febdea3-577e-41f7-ada3-35fbb756a9af' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 151.18 where id = '2113ea5f-796a-4c92-b425-5260a0193219' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 173.75 where id = '365eaa3e-f5a5-4595-b0c1-a82163dbb742' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 151.18 where id = '462d27aa-ac27-4b7b-a6de-5c416dc3bdf8' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 173.75 where id = '4b1725ef-203d-4d2d-af11-d56d0013f077' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 129.14 where id = 'd9b835fa-9c0d-450f-89cf-f33a9d29c5d4' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 165.06 where id = '55be56cd-50af-41b6-8817-f50eea0de08d' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 147.02 where id = '977c1f5d-1e4d-459d-b8b8-d5d8de5426b7' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 167.97 where id = '3ed270e2-4e7f-4b2b-807e-6d0f4b9a4610' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 164.74 where id = 'b39fa89d-f021-44c0-8bd4-0ddd704684fb' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 173.40 where id = '48394260-8e4f-4757-b7e3-79e297edd507' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 143.64 where id = 'cd1f6555-8da5-4d81-b182-79209d9125a9' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 173.40 where id = 'df11218b-17da-4558-89b8-c8f794f31217' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 147.02 where id = 'b167d95e-7e8b-405f-a3b1-cde9b357ddc0' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 173.40 where id = 'd4f61a29-5c28-4ccd-9214-6750cb7b9cc9' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 172.70 where id = 'e59ad730-0a7d-430d-ae83-f6b2ab400b47' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 176.55 where id = 'a6ea07d6-6850-4ccd-b57f-0f03434b47e4' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 173.40 where id = '10aaaebe-35e9-4082-bff4-c48dc0fabb40' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 143.08 where id = 'a530f7bf-9ed9-4e2a-be27-7dd723c79cc2' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 164.08 where id = 'cdeecbfc-6dd2-482b-966f-48a52c25c41c' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 143.08 where id = '50280242-3694-48ed-9795-96110e2bf45e' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 167.30 where id = 'fefc024c-35a3-4536-a7d6-a7d99c5a8251' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 195.44 where id = '1bf6b06a-11e8-4a1a-a557-272609e89956' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 161.11 where id = 'd083f1af-f9b1-41c9-a622-2500f7f87f53' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 190.67 where id = '945ad5ad-d0d9-4d4e-899d-e5fa811da799' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 155.86 where id = '2a4da359-359c-424b-bf75-c45c2057c62f' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 155.86 where id = 'b1d05e49-712d-4425-8779-61f3fdcad938' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 169.17 where id = '04958fa7-0b45-4c14-a9b3-29b936454750' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 322.42 where id = '0ae8e00f-f6b5-4c09-b9d2-1862a9299002' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 193.04 where id = '9598f6c6-f86c-4111-88a2-21f90f31dc97' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 193.04 where id = '8637f505-38ae-4db5-862b-7b488ef84cb4' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 193.04 where id = '383d3d8d-1e8f-4767-b890-913a7f88e943' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 174.63 where id = 'f510d75e-f519-44e3-aecc-64aa55117375' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 222.23 where id = '343ec006-8282-480f-b6c2-6adb2a40dd69' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 222.23 where id = 'd63c8c7c-62dc-4602-843d-c38c1c08223f' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 244.29 where id = '43cb60bb-9f86-4905-bcdc-6f5c116261ce' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 225.88 where id = '9c4265d2-5928-4682-aefa-2ac232411562' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 174.63 where id = 'c70374cf-9de8-41cf-9319-25140885ffa4' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 202.00 where id = '293e9dc6-7d80-492e-97ae-04f345c5d3f7' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 60.00  where id = '2c4e357c-12b0-461f-bd56-a2c419609284' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 60.00  where id = 'b32d07be-0c60-45bd-8a3d-d2730a9c2bc0' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 60.00  where id = '66f12546-b025-4e46-bd8d-ed84b78a658a' and shipping_cost_usd is null;
  update public.orders set shipping_cost_usd = 66.01  where id = 'd77572a2-ceaf-458b-a63b-f67914c782ae' and shipping_cost_usd is null;
commit;
