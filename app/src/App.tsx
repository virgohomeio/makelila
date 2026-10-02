import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';
import { AuthProvider, ProtectedRoute, useAuth } from './lib/auth';
import { canView, canAccessHiringModule, type Module } from './lib/permissions';
import { useIsAssignedInterviewer } from './lib/hiring';
import { AppShell } from './components/AppShell';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { MobileHome } from './components/MobileHome';
import { useIsMobile } from './lib/useMediaQuery';
// Eager: OrderReview is the default landing route + Login is on the auth
// path. Everything else loads on demand so first-paint is fast.
import OrderReview from './modules/OrderReview';
import Login from './modules/Login';
import ReturnForm from './modules/Forms/ReturnForm';
import CancelOrderForm from './modules/Forms/CancelOrderForm';
import ServiceRequestForm from './modules/Forms/ServiceRequestForm';
import ShippingDamageForm from './modules/Forms/ShippingDamageForm';
import ConfirmAddressPage from './modules/Forms/ConfirmAddressPage';

// Backlog #51 — Dashboard pulls in Plotly (~1MB) and telemetry. The other
// modules below get the same treatment so the main chunk doesn't carry
// leaflet (PostShipment), the heavier Service / Build / Stock / Customers
// trees, or the audit-log code unless the operator actually navigates there.
const Fulfillment = lazy(() => import('./modules/Fulfillment'));
const Service     = lazy(() => import('./modules/Service'));
const Stock       = lazy(() => import('./modules/Stock'));
const Customers   = lazy(() => import('./modules/Customers'));
const Lovely      = lazy(() => import('./modules/Lovely'));
const Team        = lazy(() => import('./modules/Team'));
const Marketing   = lazy(() => import('./modules/Marketing'));
const Finance     = lazy(() => import('./modules/Finance'));
const Products    = lazy(() => import('./modules/Products'));
const Hiring      = lazy(() => import('./modules/Hiring'));

function RequireRole({ role, children }: { role: Module; children: React.ReactNode }) {
  const { role: userRole, loading } = useAuth();
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!canView(userRole, role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Hiring-specific route guard: leadership OR anyone assigned as an
 *  interviewer on at least one posting (see lib/permissions.ts's
 *  canAccessHiringModule doc comment for the null-role reasoning). Kept
 *  separate from the generic RequireRole above — that component is shared
 *  by every leadership-only module (Finance today, others later) and
 *  Hiring's extra async assignment check doesn't belong there. */
function RequireHiringAccess({ children }: { children: React.ReactNode }) {
  const { role, loading: authLoading } = useAuth();
  const { isAssigned, loading: assignedLoading } = useIsAssignedInterviewer();
  if (authLoading || assignedLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!canAccessHiringModule(role, isAssigned)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function LazyRoute({ children }: { children: React.ReactNode }) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<div style={{ padding: 24, color: '#4a5568' }}>Loading…</div>}>
        {children}
      </Suspense>
    </RouteErrorBoundary>
  );
}

function HomeRoute() {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileHome />;
  return <Navigate to="/team" replace />;
}

/** Maps a pre-merge /shipping URL onto its Fulfillment tab.
 *
 *  Only `claims` needs translating. /shipping/claims was the carrier claims we
 *  file with Freightcom, while /fulfillment/claims is the damage a customer
 *  reports — sending the old link to the same-named new tab would land an
 *  operator on the wrong list without any sign they were somewhere else. */
const SHIPPING_TAB_MAP: Record<string, string> = {
  shipping: 'shipping',
  invoices: 'invoices',
  claims:   'carrier-claims',
};

function ShippingRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  const target = (tab && SHIPPING_TAB_MAP[tab]) ?? 'shipping';
  return <Navigate to={`/fulfillment/${target}`} replace />;
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Public customer-facing forms — no auth required */}
          <Route path="/return"          element={<ReturnForm />} />
          <Route path="/cancel-order"    element={<CancelOrderForm />} />
          <Route path="/service-request" element={<ServiceRequestForm />} />
          <Route path="/shipping-damage" element={<ShippingDamageForm />} />
          <Route path="/confirm-address" element={<ConfirmAddressPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppShell><Outlet /></AppShell>
              </ProtectedRoute>
            }
          >
            <Route index element={<HomeRoute />} />
            {/* Upload moved into the Sales module as a sub-tab; keep the old
                path working by redirecting into it. */}
            <Route path="upload"            element={<Navigate to="/order-review" replace />} />
            <Route path="order-review"          element={<OrderReview />} />
            <Route path="order-review/:orderId" element={<OrderReview />} />
            <Route path="fulfillment"       element={<LazyRoute><Fulfillment /></LazyRoute>} />
            <Route path="fulfillment/:tab"  element={<LazyRoute><Fulfillment /></LazyRoute>} />
            {/* Shipping was folded into Fulfillment on 2026-08-28 — booking,
                the delivery map, carrier invoices and carrier claims all
                describe the same leg of an order. Old links and bookmarks are
                mapped rather than dropped; note the tab rename, since
                /shipping/claims and /fulfillment/claims were two different
                things. */}
            <Route path="shipping"      element={<ShippingRedirect />} />
            <Route path="shipping/:tab" element={<ShippingRedirect />} />
            <Route path="build"         element={<Navigate to="/stock" replace />} />
            <Route path="post-shipment" element={<Navigate to="/fulfillment" replace />} />
            <Route path="service"       element={<LazyRoute><Service /></LazyRoute>} />
            <Route path="stock"         element={<LazyRoute><Stock /></LazyRoute>} />
            <Route path="customers"     element={<LazyRoute><Customers /></LazyRoute>} />
            <Route path="lovely"        element={<LazyRoute><Lovely /></LazyRoute>} />
            <Route path="templates"     element={<Navigate to="/order-review" replace />} />
            <Route path="marketing"     element={<LazyRoute><Marketing /></LazyRoute>} />
            <Route path="activity-log"  element={<Navigate to="/team" replace />} />
            <Route path="team"          element={<LazyRoute><Team /></LazyRoute>} />
            <Route path="dashboard"     element={<Navigate to="/customers" replace />} />
            <Route path="finance" element={
              <RequireRole role="finance">
                <LazyRoute><Finance /></LazyRoute>
              </RequireRole>
            } />
            <Route path="hiring" element={
              <RequireHiringAccess>
                <LazyRoute><Hiring /></LazyRoute>
              </RequireHiringAccess>
            } />
            <Route path="products" element={<LazyRoute><Products /></LazyRoute>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
