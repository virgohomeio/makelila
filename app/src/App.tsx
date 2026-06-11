import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, ProtectedRoute, useAuth } from './lib/auth';
import { canView, type Module } from './lib/permissions';
import { AppShell } from './components/AppShell';
import { MobileHome } from './components/MobileHome';
import { useIsMobile } from './lib/useMediaQuery';
import { isTelemetryConfigured } from './lib/supabaseTelemetry';
// Eager: OrderReview is the default landing route + Login is on the auth
// path. Everything else loads on demand so first-paint is fast.
import OrderReview from './modules/OrderReview';
import Login from './modules/Login';
import ReturnForm from './modules/Forms/ReturnForm';
import CancelOrderForm from './modules/Forms/CancelOrderForm';
import ServiceRequestForm from './modules/Forms/ServiceRequestForm';

// Backlog #51 — Dashboard pulls in Plotly (~1MB) and telemetry. The other
// modules below get the same treatment so the main chunk doesn't carry
// leaflet (PostShipment), the heavier Service / Build / Stock / Customers
// trees, or the audit-log code unless the operator actually navigates there.
const Dashboard   = lazy(() => import('./modules/Dashboard'));
const Fulfillment = lazy(() => import('./modules/Fulfillment'));
const Build       = lazy(() => import('./modules/Build'));
const Service     = lazy(() => import('./modules/Service'));
const Stock       = lazy(() => import('./modules/Stock'));
const Customers   = lazy(() => import('./modules/Customers'));
const Templates   = lazy(() => import('./modules/Templates'));
const ActivityLog = lazy(() => import('./modules/ActivityLog'));
const Team        = lazy(() => import('./modules/Team'));
const Marketing   = lazy(() => import('./modules/Marketing'));
const Finance     = lazy(() => import('./modules/Finance'));

function RequireRole({ role, children }: { role: Module; children: React.ReactNode }) {
  const { role: userRole, loading } = useAuth();
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!canView(userRole, role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function LazyRoute({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#4a5568' }}>Loading…</div>}>
      {children}
    </Suspense>
  );
}

function HomeRoute() {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileHome />;
  return <Navigate to="/order-review" replace />;
}

function DashboardRoute() {
  if (!isTelemetryConfigured) {
    return (
      <div style={{ padding: 24, color: '#4a5568' }}>
        <h2 style={{ marginTop: 0 }}>Telemetry not configured</h2>
        <p>
          The Dashboard reads from the device-telemetry Supabase project.
          Set <code>VITE_TELEMETRY_SUPABASE_URL</code> and{' '}
          <code>VITE_TELEMETRY_SUPABASE_ANON_KEY</code> in <code>.env</code> (see{' '}
          <code>.env.example</code>) and reload.
        </p>
      </div>
    );
  }
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading dashboard…</div>}>
      <Dashboard />
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Public customer-facing forms — no auth required */}
          <Route path="/return"       element={<ReturnForm />} />
          <Route path="/cancel-order" element={<CancelOrderForm />} />
          <Route path="/service-request" element={<ServiceRequestForm />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppShell><Outlet /></AppShell>
              </ProtectedRoute>
            }
          >
            <Route index element={<HomeRoute />} />
            <Route path="order-review"          element={<OrderReview />} />
            <Route path="order-review/:orderId" element={<OrderReview />} />
            <Route path="fulfillment"       element={<LazyRoute><Fulfillment /></LazyRoute>} />
            <Route path="fulfillment/:tab"  element={<LazyRoute><Fulfillment /></LazyRoute>} />
            <Route path="build"         element={<Navigate to="/stock" replace />} />
            <Route path="post-shipment" element={<Navigate to="/fulfillment" replace />} />
            <Route path="service"       element={<LazyRoute><Service /></LazyRoute>} />
            <Route path="stock"         element={<LazyRoute><Stock /></LazyRoute>} />
            <Route path="customers"     element={<LazyRoute><Customers /></LazyRoute>} />
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
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
