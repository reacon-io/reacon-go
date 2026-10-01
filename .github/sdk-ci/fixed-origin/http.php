<?php
/** Test-only HTTP transport; the package always emits the fixed API origin. */
function fixtureHttp(string $target, ?GuzzleHttp\ClientInterface $inner = null): GuzzleHttp\ClientInterface {
    return new class($target, $inner ?? Reacon\Sdk\Http\RequestPolicy::client()) implements GuzzleHttp\ClientInterface {
        public function __construct(private string $target, private GuzzleHttp\ClientInterface $inner) {}
        private function route(Psr\Http\Message\RequestInterface $request): Psr\Http\Message\RequestInterface {
            $uri=$request->getUri();
            if ($uri->getScheme()!=='https'||$uri->getHost()!=='api.reacon.io') throw new RuntimeException('SDK changed its fixed API origin');
            $base=new GuzzleHttp\Psr7\Uri($this->target);
            if (!in_array($base->getHost(),['127.0.0.1','localhost'],true)) throw new RuntimeException('Loopback fixtures only');
            return $request->withUri($base->withPath(rtrim($base->getPath(),'/').$uri->getPath())->withQuery($uri->getQuery()));
        }
        public function send(Psr\Http\Message\RequestInterface $request, array $options=[]): Psr\Http\Message\ResponseInterface { return $this->inner->send($this->route($request),$options); }
        public function sendAsync(Psr\Http\Message\RequestInterface $request, array $options=[]): GuzzleHttp\Promise\PromiseInterface { return $this->inner->sendAsync($this->route($request),$options); }
        public function request(string $method, $uri='', array $options=[]): Psr\Http\Message\ResponseInterface { return $this->send(new GuzzleHttp\Psr7\Request($method,$uri),$options); }
        public function requestAsync(string $method, $uri='', array $options=[]): GuzzleHttp\Promise\PromiseInterface { return $this->sendAsync(new GuzzleHttp\Psr7\Request($method,$uri),$options); }
        public function getConfig(?string $option=null) { return $this->inner->getConfig($option); }
    };
}
