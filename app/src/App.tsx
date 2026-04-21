import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './lib/auth';
import { AppShell } from './components/AppShell';
import OrderReview from './modules/OrderReview';
import Fulfillment from './modules/Fulfillment';
import PostShipment from './modules/PostShipment';
import Stock from './modules/Stock';
import Customers from './modules/Customers';
import ActivityLog from './modules/ActivityLog';
import Login from './modules/Login';

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
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
            <Route path="post-shipment" element={<PostShipment />} />
            <Route path="stock"         element={<Stock />} />
            <Route path="customers"     element={<Customers />} />
            <Route path="activity-log"  element={<ActivityLog />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
