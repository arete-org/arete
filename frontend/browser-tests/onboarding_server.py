"""Disposable HTTP fixture: real ledger routes, no scheduler/provider/model."""

from fastapi import FastAPI, Request

from arete.api.onboarding import router
from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main
from arete.services.athlete_scope import athlete_scope

main()
with db_connection() as con:
    con.executemany("INSERT INTO app.athletes(id) VALUES (?) ON CONFLICT DO NOTHING", [(i,) for i in range(101, 111)])
app = FastAPI()


@app.middleware("http")
async def test_identity(request: Request, call_next):
    # Test-only trusted identities; production establishes scope through Clerk.
    ident = int(request.headers.get("x-test-athlete", "101"))
    assert 101 <= ident <= 110
    with athlete_scope(ident):
        return await call_next(request)


app.include_router(router)
