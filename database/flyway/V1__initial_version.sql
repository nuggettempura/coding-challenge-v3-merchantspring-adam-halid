CREATE TABLE generic.store (
  store_id BIGSERIAL,
  merchant_id TEXT NOT NULL,
  marketplace_type TEXT NOT NULL,
  marketplace_subtype TEXT NOT NULL,
  marketplace_country TEXT NOT NULL,
  -- Internal identifier. Customisable (e.g. derived from a marketplace-facing ID)
  -- as long as it keeps the primary key unique.
  source_system_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
  UNIQUE (store_id),
  PRIMARY KEY (
    marketplace_type,
    marketplace_subtype,
    marketplace_country,
    source_system_id
  )
);

CREATE TABLE generic.product (
  product_id BIGSERIAL,
  store_id BIGINT NOT NULL REFERENCES generic.store (store_id) ON DELETE CASCADE,
  marketplace_type TEXT NOT NULL,
  marketplace_subtype TEXT NOT NULL,
  marketplace_country TEXT NOT NULL,
  -- Internal identifier. Customisable (e.g. derived from a marketplace-facing ID)
  -- as long as it keeps the primary key unique.
  source_system_id TEXT NOT NULL,
  seller_sku TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT NOT NULL,
  link_url TEXT NOT NULL,
  price DECIMAL(13, 2) NOT NULL,
  brand TEXT DEFAULT NULL,
  fulfilled_by TEXT NOT NULL,
  is_active BOOLEAN NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
  UNIQUE (product_id),
  PRIMARY KEY (
    marketplace_type,
    marketplace_subtype,
    marketplace_country,
    source_system_id
  )
);

CREATE TABLE vendor.product_sales (
  id BIGSERIAL,
  product_id BIGINT NOT NULL REFERENCES generic.product (product_id) ON DELETE CASCADE,
  store_id BIGINT NOT NULL REFERENCES generic.store (store_id) ON DELETE CASCADE,
  glance_views INT DEFAULT NULL,
  ordered_revenue DECIMAL(13, 2) NOT NULL,
  ordered_units INT NOT NULL,
  shipped_revenue DECIMAL(13, 2) NOT NULL,
  shipped_units INT NOT NULL,
  shipped_cogs DECIMAL(13, 2) NOT NULL,
  customer_returns INT NOT NULL,
  shipped_revenue_total DECIMAL(13, 2) NOT NULL,
  shipped_units_total INT NOT NULL,
  shipped_cogs_total DECIMAL(13, 2) NOT NULL,
  customer_returns_total INT NOT NULL,
  report_date TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (product_id, store_id, report_date)
);

SELECT create_hypertable('vendor.product_sales', 'report_date');

CREATE TYPE deduction_basis_enum AS ENUM('FIXED_AMOUNT', 'NET_RECEIPTS');

CREATE TABLE vendor.deductions (
  deduction_id BIGSERIAL,
  store_id BIGINT NOT NULL REFERENCES generic.store (store_id) ON DELETE CASCADE,
  deduction_type TEXT NOT NULL,
  deduction_basis deduction_basis_enum NOT NULL,
  deduction_value DECIMAL(13, 2) NOT NULL,
  currency TEXT NOT NULL,
  vendor_code TEXT NULL,
  effective_date_from TIMESTAMPTZ NOT NULL,
  effective_date_to TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (deduction_id)
);

CREATE TABLE vendor.expense_events (
  store_id BIGINT NOT NULL REFERENCES generic.store (store_id) ON DELETE CASCADE,
  -- Internal identifier. Customisable (e.g. derived from a marketplace-facing ID)
  -- as long as it keeps the primary key unique.
  source_system_id TEXT NOT NULL,
  product_sku TEXT,
  expense_date TIMESTAMP WITH TIME ZONE NOT NULL,
  vendor_code TEXT,
  expense_type TEXT NOT NULL,
  expense_subtype TEXT NOT NULL,
  cost DECIMAL(13, 2) NOT NULL,
  expense_status TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (
    store_id,
    source_system_id,
    expense_date,
    expense_type,
    expense_subtype
  )
);

SELECT create_hypertable('vendor.expense_events', 'expense_date');