import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { createAppRoutes } from './pages/appRoutes';

const router = createBrowserRouter(createAppRoutes());

function App() {
  return <RouterProvider router={router} />;
}

export default App;
