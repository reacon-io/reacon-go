"""Test-only HTTPX routing. SDK package bytes and its public origin stay intact."""
import httpx

def route_http(http, base):
    target = httpx.URL(base)
    assert target.host == '127.0.0.1' and target.scheme == 'http', 'Loopback fixtures only'
    async def route(request):
        assert request.url.scheme == 'https' and request.url.host == 'api.reacon.io', 'SDK changed its fixed origin'
        request.url = target.copy_with(raw_path=target.raw_path.rstrip(b'/') + request.url.raw_path)
    http.event_hooks['request'].append(route)
    return http

def route_api(api, base):
    rest = api.rest_client
    create = rest._create_pool_manager
    def routed_pool():
        return route_http(create(), base)
    if rest.pool_manager is None:
        rest._create_pool_manager = routed_pool
    else:
        route_http(rest.pool_manager, base)
    return api
