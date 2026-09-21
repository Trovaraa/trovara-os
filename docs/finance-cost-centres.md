# Finance cost centres

The shared catalogue includes these additional centres:

| Code | Name | Covers |
| --- | --- | --- |
| CC02 | Farm Operations & Shared Services | General tools, community relations and travelling costs |
| CC03 | Infrastructure & Utilities | Access roads, drainage and energy |
| CC04 | Land & Site Development | Land acquisition, registration and site clearing |

Codes retain the existing `CC01` format. Finance imports also accept hyphenated codes
such as `CC-02`, converting them to their canonical form before review. The catalogue
feeds expense and crop-cycle selectors, expense filters, import validation and
cost-centre summaries. Names and descriptions are available in all four UI locales.

Apply migration `20260921140000_0086_cost_centres` before deploying the updated API.
It expands the expense check constraint; it does not update or reclassify any rows.
The payment/CAPEX release is tracked separately in PR #58. Preserve that release when
deploying to the existing production overlay; do not replace it with a main-only build.
Deploy both pending migrations in timestamp order on environments needing both.

Run `npm run test:cost-centre-migration` with `FINANCE_TEST_DATABASE_URL` pointing to
a disposable `finance_test_*` database to check row preservation and constraint behavior.

Cost centre and CAPEX classification are separate: assigning CC03 or CC04 does not
automatically label an expense CAPEX or create an asset. Existing assignments remain
unchanged and can be reviewed individually by an authorized Finance user.
