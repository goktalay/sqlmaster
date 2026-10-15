#!/usr/bin/env bash
# Tanıtım ekran görüntüleri için örnek veriyi hazırlar (yalnız geliştirme; tests/e2e/screenshots.mjs ile kullanılır).
# Kullanım: scripts/shot-data.sh tr|en
#   PostgreSQL: "sqlm-shot" konteyneri 127.0.0.1:55432 (postgres/secret), tek örnek veritabanı
#   DuckDB dosyaları: tr → /veri/satislar.csv + magazalar.json, en → /data-en/sales.csv + stores.json
# Tüm veriler uydurmadır; gerçek kişi/şirket bilgisi içermez.
set -euo pipefail
LANG_="${1:-tr}"
if [ "$LANG_" = en ]; then DB=store; S=sales; else DB=magaza; S=satis; fi

docker rm -f sqlm-shot >/dev/null 2>&1 || true
docker run -d --rm --name sqlm-shot -e POSTGRES_PASSWORD=secret -e POSTGRES_DB="$DB" -p 127.0.0.1:55432:5432 postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec sqlm-shot pg_isready -U postgres -d "$DB" >/dev/null 2>&1 && break; sleep 1; done
sleep 2

if [ "$LANG_" = en ]; then
docker exec -i sqlm-shot psql -q -v ON_ERROR_STOP=1 -U postgres -d store <<'EOF'
create schema sales;
create table sales.customers (id serial primary key, name text not null, city text, segment text, signup_date date default current_date);
create table sales.products (id serial primary key, name text not null, category text, price numeric(10,2));
create table sales.orders (id serial primary key, customer_id int references sales.customers(id), product_id int references sales.products(id), qty int, amount numeric(12,2), status text, order_date timestamptz);
insert into sales.customers(name, city, segment, signup_date)
select (array['Northwind','Bluebird','Summit','Riverside','Lakeview','Harbor','Pinecrest','Evergreen','Redwood','Silverline'])[1+g%10] || ' ' || (array['Trading','Foods','Builders','Textiles','Logistics','Tech','Furniture'])[1+g%7] || ' Ltd.',
       (array['London','Berlin','New York','Toronto','Sydney','Amsterdam','Chicago','Dublin'])[1+g%8], (array['Enterprise','SMB','Consumer'])[1+g%3], date '2024-01-01' + (g*3 % 600)
from generate_series(1,800) g;
insert into sales.products(name, category, price) values ('Wireless Keyboard','Accessories',49.90),('27" Monitor','Displays',329.00),('Laptop Bag','Accessories',59.50),('USB-C Dock','Accessories',149.00),('Mechanical Keyboard','Accessories',129.00),('Ergonomic Chair','Furniture',499.00),('Desk Lamp','Furniture',39.00),('Webcam','Displays',89.00);
insert into sales.orders(customer_id, product_id, qty, amount, status, order_date)
select 1 + (g*7 % 800), 1 + g % 8, 1 + g % 5, round(((1 + g % 5) * (array[49.90,329,59.5,149,129,499,39,89])[1 + g % 8])::numeric, 2),
       (array['New','Processing','Shipped','Delivered','Returned'])[1 + g % 5], timestamptz '2026-01-01 09:00' + (g * interval '47 minutes')
from generate_series(1,25000) g;
create view sales.monthly_revenue as select date_trunc('month', order_date)::date as month, count(*) as orders, sum(amount) as revenue from sales.orders where status <> 'Returned' group by 1 order by 1;
create function sales.customer_revenue(p_customer int) returns numeric language sql stable as $$
  select coalesce(sum(amount), 0) from sales.orders where customer_id = p_customer and status <> 'Returned'
$$;
create function sales.order_check() returns trigger language plpgsql as $$
begin
  if new.qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  new.amount := round(new.amount, 2);
  return new;
end $$;
create trigger order_check before insert or update on sales.orders for each row execute function sales.order_check();
create index orders_customer_idx on sales.orders(customer_id);
analyze;
EOF
else
docker exec -i sqlm-shot psql -q -v ON_ERROR_STOP=1 -U postgres -d magaza <<'EOF'
create schema satis;
create table satis.musteriler (id serial primary key, ad text not null, sehir text, segment text, kayit_tarihi date default current_date);
create table satis.urunler (id serial primary key, ad text not null, kategori text, fiyat numeric(10,2));
create table satis.siparisler (id serial primary key, musteri_id int references satis.musteriler(id), urun_id int references satis.urunler(id), adet int, tutar numeric(12,2), durum text, siparis_tarihi timestamptz);
insert into satis.musteriler(ad, sehir, segment, kayit_tarihi)
select (array['Anadolu','Ege','Marmara','Karadeniz','Akdeniz','Toros','Yıldız','Deniz','Kuzey','Güney'])[1+g%10] || ' ' || (array['Ticaret','Gıda','Yapı','Tekstil','Lojistik','Teknoloji','Mobilya'])[1+g%7] || ' A.Ş.',
       (array['İstanbul','Ankara','İzmir','Bursa','Antalya','Konya','Kayseri','Trabzon'])[1+g%8], (array['Kurumsal','KOBİ','Bireysel'])[1+g%3], date '2024-01-01' + (g*3 % 600)
from generate_series(1,800) g;
insert into satis.urunler(ad, kategori, fiyat) values ('Kablosuz Klavye','Aksesuar',749.90),('27" Monitör','Ekran',8499.00),('Dizüstü Çanta','Aksesuar',1299.50),('USB-C Dock','Aksesuar',2399.00),('Mekanik Klavye','Aksesuar',2899.00),('Ergonomik Sandalye','Mobilya',11999.00),('Masa Lambası','Mobilya',899.00),('Web Kamerası','Ekran',1799.00);
insert into satis.siparisler(musteri_id, urun_id, adet, tutar, durum, siparis_tarihi)
select 1 + (g*7 % 800), 1 + g % 8, 1 + g % 5, round(((1 + g % 5) * (array[749.90,8499,1299.5,2399,2899,11999,899,1799])[1 + g % 8])::numeric, 2),
       (array['Yeni','Hazırlanıyor','Kargoda','Teslim edildi','İade'])[1 + g % 5], timestamptz '2026-01-01 09:00' + (g * interval '47 minutes')
from generate_series(1,25000) g;
create view satis.aylik_ciro as select date_trunc('month', siparis_tarihi)::date ay, count(*) siparis, sum(tutar) ciro from satis.siparisler where durum <> 'İade' group by 1 order by 1;
create function satis.musteri_cirosu(p_musteri int) returns numeric language sql stable as $$
  select coalesce(sum(tutar), 0) from satis.siparisler where musteri_id = p_musteri and durum <> 'İade'
$$;
create function satis.siparis_durum_kontrol() returns trigger language plpgsql as $$
begin
  if new.adet <= 0 then raise exception 'Adet sıfırdan büyük olmalı'; end if;
  new.tutar := round(new.tutar, 2);
  return new;
end $$;
create trigger siparis_kontrol before insert or update on satis.siparisler for each row execute function satis.siparis_durum_kontrol();
create index siparisler_musteri_idx on satis.siparisler(musteri_id);
analyze;
EOF
fi

python3 - "$LANG_" <<'EOF'
import json, os, random, sys
random.seed(7)
en = sys.argv[1] == 'en'
d = '/data-en' if en else '/veri'
os.makedirs(d, exist_ok=True)
if en:
    cities = ['London', 'Manchester', 'Berlin', 'Munich', 'New York', 'Chicago']
    regions = ['UK', 'UK', 'Germany', 'Germany', 'USA', 'USA']
    products = ['Wireless Keyboard', '27" Monitor', 'USB-C Dock', 'Ergonomic Chair', 'Desk Lamp', 'Webcam']
    csv, js, head, lo, hi = 'sales.csv', 'stores.json', 'invoice_no,date,store_code,product,qty,amount', 15, 500
    store = lambda i: {'store_code': f'S{i:02d}', 'city': cities[i-1], 'region': regions[i-1]}
    code = lambda: f'S{random.randint(1, 6):02d}'
else:
    cities = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya', 'Konya']
    regions = ['Marmara', 'İç Anadolu', 'Ege', 'Marmara', 'Akdeniz', 'İç Anadolu']
    products = ['Kablosuz Klavye', '27" Monitör', 'USB-C Dock', 'Ergonomik Sandalye', 'Masa Lambası', 'Web Kamerası']
    csv, js, head, lo, hi = 'satislar.csv', 'magazalar.json', 'fatura_no,tarih,magaza_kodu,urun,adet,tutar', 300, 12000
    store = lambda i: {'magaza_kodu': f'M{i:02d}', 'il': cities[i-1], 'bolge': regions[i-1]}
    code = lambda: f'M{random.randint(1, 6):02d}'
with open(os.path.join(d, csv), 'w', encoding='utf-8') as f:
    f.write(head + '\n')
    for i in range(1, 5001):
        p = random.choice(products); q = random.randint(1, 6)
        f.write(f'{"INV" if en else "F"}{20260000+i},2026-{random.randint(1,9):02d}-{random.randint(1,28):02d},{code()},"{p.replace(chr(34), chr(34)*2)}",{q},{round(q*random.uniform(lo, hi), 2)}\n')
json.dump([store(i) for i in range(1, 7)], open(os.path.join(d, js), 'w', encoding='utf-8'), ensure_ascii=False)
EOF
echo "Hazır: $LANG_ ($DB.$S)"
