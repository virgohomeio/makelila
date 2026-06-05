import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './lib/auth';
import { AppShell } from './components/AppShell';
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
const PostShipment = lazy(() => import('./modules/PostShipment'));
const Service     = lazy(() => import('./modules/Service'));
const Stock       = lazy(() => import('./modules/Stock'));
const Customers   = lazy(() => import('./modules/Customers'));
const Templates   = lazy(() => import('./modules/Templates'));
const ActivityLog = lazy(() => import('./modules/ActivityLog'));

function LazyRoute({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#4a5568' }}>Loading…</div>}>
      {children}
    </Suspense>
  );
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
            <Route index element={<Navigate to="order-review" replace />} />
            <Route path="order-review"          element={<OrderReview />} />
            <Route path="order-review/:orderId" element={<OrderReview />} />
            <Route path="fulfillment"       element={<LazyRoute><Fulfillment /></LazyRoute>} />
            <Route path="fulfillment/:tab"  element={<LazyRoute><Fulfillment /></LazyRoute>} />
            <Route path="build"         element={<LazyRoute><Build /></LazyRoute>} />
            <Route path="post-shipment" element={<LazyRoute><PostShipment /></LazyRoute>} />
            <Route path="service"       element={<LazyRoute><Service /></LazyRoute>} />
            <Route path="stock"         element={<LazyRoute><Stock /></LazyRoute>} />
            <Route path="customers"     element={<LazyRoute><Customers /></LazyRoute>} />
            <Route path="templates"     element={<LazyRoute><Templates /></LazyRoute>} />
            <Route path="activity-log"  element={<LazyRoute><ActivityLog /></LazyRoute>} />
            <Route path="dashboard"     element={<DashboardRoute />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
