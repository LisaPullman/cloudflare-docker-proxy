/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// #############################
// ### START OF YOUR CONFIG  ###
// #############################

// --- 1. YOUR DOMAIN ---
// Replace "20200108.xyz" with your actual domain name.
const CUSTOM_DOMAIN = "20200108.xyz";

// --- 2. DEBUG MODE (Optional) ---
// Set to "debug" to enable debug headers and messages.
// Leave as "" for production.
const MODE = ""; 

// --- 3. DEBUG UPSTREAM (Optional, for debug mode only) ---
// If MODE is "debug", all requests will be forwarded to this upstream.
const TARGET_UPSTREAM = "https://registry-1.docker.io";

// #############################
// ###  END OF YOUR CONFIG   ###
// #############################


// --- Core Worker Logic (No changes needed below) ---

addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const dockerHub = "https://registry-1.docker.io";

const routes = {
  // production routes are now generated automatically using your CUSTOM_DOMAIN
  ["docker." + CUSTOM_DOMAIN]: dockerHub,
  ["quay." + CUSTOM_DOMAIN]: "https://quay.io",
  ["gcr." + CUSTOM_DOMAIN]: "https://gcr.io",
  ["k8s-gcr." + CUSTOM_DOMAIN]: "https://k8s.gcr.io",
  ["k8s." + CUSTOM_DOMAIN]: "https://registry.k8s.io",
  ["ghcr." + CUSTOM_DOMAIN]: "https://ghcr.io",
  ["cloudsmith." + CUSTOM_DOMAIN]: "https://docker.cloudsmith.io",
  ["ecr." + CUSTOM_DOMAIN]: "https://public.ecr.aws",

  // staging routes for testing
  ["docker-staging." + CUSTOM_DOMAIN]: dockerHub,
};

function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
  if (MODE == "debug") {
    return TARGET_UPSTREAM;
  }
  return "";
}

async function handleRequest(request) {
  const url = new URL(request.url);
  // Handle root path request
  if (url.pathname == "/") {
    //
    const newUrl = new URL(request.url);
    const host = newUrl.hostname;
    //check if host is in routes
    if(host in routes){
        newUrl.pathname = "/v2/";
        return Response.redirect(newUrl, 301);
    }
    // if not in routes, return the routes list
    return new Response(
        JSON.stringify({
          message: "Welcome to Cloudflare Docker Proxy!",
          routes: Object.keys(routes),
          repository: "https://github.com/ciiiii/cloudflare-docker-proxy",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
  }

  const upstream = routeByHosts(url.hostname);
  if (upstream === "") {
    return new Response(
      JSON.stringify({
        message: "Route not found for this hostname. Please check your configuration.",
        routes: Object.keys(routes),
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
  const isDockerHub = upstream == dockerHub;
  const authorization = request.headers.get("Authorization");
  if (url.pathname == "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    if (authorization) {
      headers.set("Authorization", authorization);
    }
    // check if need to authenticate
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      headers: headers,
      redirect: "follow",
    });
    if (resp.status === 401) {
      return responseUnauthorized(url);
    }
    return resp;
  }
  // get token
  if (url.pathname.endsWith("/v2/auth") || url.pathname.endsWith("/token")) {
    const newUrl = new URL(upstream + "/v2/");
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      redirect: "follow",
    });
    if (resp.status !== 401) {
      return resp;
    }
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (authenticateStr === null) {
      return resp;
    }
    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    let scope = url.searchParams.get("scope");
    // autocomplete repo part into scope for DockerHub library images
    // Example: repository:busybox:pull => repository:library/busybox:pull
    if (scope && isDockerHub) {
      let scopeParts = scope.split(":");
      if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
        scopeParts[1] = "library/" + scopeParts[1];
        scope = scopeParts.join(":");
      }
    }
    return await fetchToken(wwwAuthenticate, scope, authorization);
  }
  
  const path = url.pathname;
  const newUrl = new URL(upstream + path);

  // redirect for DockerHub library images
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  if (isDockerHub) {
    const pathParts = path.split("/");
    if (pathParts.length == 5 && pathParts[1] === "v2" && !pathParts[2].includes("library")) {
      const newPath = "/v2/library/" + path.substring(4);
      const redirectUrl = new URL(url);
      redirectUrl.pathname = newPath;
      return Response.redirect(redirectUrl, 301);
    }
  }

  // foward requests
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    // don't follow redirect to dockerhub blob upstream
    redirect: isDockerHub ? "manual" : "follow",
  });
  const resp = await fetch(newReq);
  if (resp.status == 401) {
    return responseUnauthorized(url);
  }
  // handle dockerhub blob redirect manually
  if (isDockerHub && resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get("Location");
    if (location) {
        const redirectResp = await fetch(location, {
            method: "GET",
            headers: request.headers, // forward original headers
            redirect: "follow",
          });
          return redirectResp;
    }
  }
  return resp;
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    // some registry response may not include service
    if (matches != null && matches.length == 1) {
        return {
            realm: matches[0],
            service: "",
          };
    }
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service && wwwAuthenticate.service.length > 0) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  return await fetch(url, { method: "GET", headers: headers });
}

function responseUnauthorized(url) {
  const headers = new Headers();
  const realm = (MODE === "debug" ? "http://" : "https://") + url.hostname + "/v2/auth";
  headers.set(
      "Www-Authenticate",
      `Bearer realm="${realm}",service="cloudflare-docker-proxy"`
    );
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers: headers,
  });
}
