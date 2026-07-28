/**
 * 404 page. Reached via notFound() from the content route, so the response really
 * carries HTTP 404 — the route used to render this body with HTTP 200, which
 * search engines index as a real page (a "soft 404") and which lies to every
 * client that checks the status code.
 */
export default function NotFound() {
  return (
    <div className="notfound">
      <h1>404 — Not found</h1>
      <p>
        There is no published content at this address. If you expected the site&rsquo;s front page here, no start
        page is set yet — pick one in the CMS tree with &ldquo;Set as start page&rdquo;.
      </p>
    </div>
  );
}
