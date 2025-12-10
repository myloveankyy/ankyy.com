/* --- frontend/src/App.js --- */

import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage';
import MusicBoxPage from './pages/MusicBoxPage';
import BlogFeed from './pages/BlogFeed'; // New Import
import Article from './pages/Article';   // New Import

function App() {
  return (
    <Router>
      <Routes>
        {/* Main Landing */}
        <Route path="/" element={<HomePage />} />
        
        {/* Tools */}
        <Route path="/tools/musicbox" element={<MusicBoxPage />} />
        
        {/* Editorial / Blog */}
        <Route path="/blog" element={<BlogFeed />} />
        <Route path="/blog/:slug" element={<Article />} />
      </Routes>
    </Router>
  );
}

export default App;