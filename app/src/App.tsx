import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './lib/auth';
import { AppShell } from './components/AppShell';
import { isTelemetryConfigured } from './lib/supabaseTelemetry';
import OrderReview from './modules/OrderReview';
import Fulfillment from './modules/Fulfillment';
import Build from './modules/Build';
import PostShipment from './modules/PostShipment';
import Service from './modules/Service';
import Stock from './modules/Stock';
import Customers from './modules/Customers';
import Templates from './modules/Templates';
import ActivityLog from './modules/ActivityLog';
import Login from './modules/Login';
import ReturnForm from './modules/Forms/ReturnForm';
import CancelOrderForm from './modules/Forms/CancelOrderForm';
import ServiceRequestForm from './modules/Forms/ServiceRequestForm';

// Lazy-loaded: the Dashboard pulls in Plotly (~1MB) and the telemetry
// Supabase client. Keeping it out of the main chunk speeds up the
// initial paint of operational routes and prevents a telemetry-config
// gap from blocking login.
const Dashboard = lazy(() => import('./modules/Dashboard'));

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
            <Route path="fulfillment"       element={<Fulfillment />} />
            <Route path="fulfillment/:tab"  element={<Fulfillment />} />
            <Route path="build"         element={<Build />} />
            <Route path="post-shipment" element={<PostShipment />} />
            <Route path="service"       element={<Service />} />
            <Route path="stock"         element={<Stock />} />
            <Route path="customers"     element={<Customers />} />
            <Route path="templates"     element={<Templates />} />
            <Route path="activity-log"  element={<ActivityLog />} />
            <Route path="dashboard"     element={<DashboardRoute />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
