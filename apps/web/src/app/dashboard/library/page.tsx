'use client';
import Topbar from '@/components/Topbar';
import { useState, useEffect, useCallback } from 'react';
import { libraryApi, studentApi, teacherApi } from '@/lib/api';
import { useLoading } from '@/context/LoadingContext';
import { useAuth } from '@/context/AuthContext';

export default function LibraryPage() {
  const { user } = useAuth();
  const { startLoading, stopLoading } = useLoading();
  const [books, setBooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('All');
  const [showIssue, setShowIssue] = useState<string | null>(null);
  const [issueStudent, setIssueStudent] = useState('');

  const fetchBooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const isStudent = user?.role === 'STUDENT';
      const isTeacher = user?.role === 'TEACHER';
      if (isStudent || isTeacher) {
        const issues = isStudent ? await studentApi.getMyLibrary() : await teacherApi.getMyLibrary();
        const mapped = issues.map((iss: any) => ({
          ...iss.book,
          available: 0,
          issued: 1,
          isIssuedToMe: true,
          dueDate: iss.dueDate
        }));
        setBooks(mapped);
      } else {
        const result = await libraryApi.getBooks({ search: search || undefined, category: filterCat !== 'All' ? filterCat : undefined });
        setBooks(result.data);
      }
    } catch (err: any) {
      setError(err?.detail || err?.message || 'Failed to load books. Please ensure the backend is running.');
      setBooks([]);
    }
    setLoading(false);
  }, [search, filterCat, user]);

  useEffect(() => { fetchBooks(); }, [fetchBooks]);

  const filtered = books.filter(b => {
    const matchSearch = b.title.toLowerCase().includes(search.toLowerCase()) || b.author.toLowerCase().includes(search.toLowerCase());
    const matchCat = filterCat === 'All' || b.category === filterCat;
    return matchSearch && matchCat;
  });

  const issueBook = async (id: string) => {
    const isStudent = user?.role === 'STUDENT';
    const isTeacher = user?.role === 'TEACHER';
    if (!isStudent && !isTeacher && !issueStudent) { alert('Please enter a Student ID.'); return; }
    startLoading('Issuing book...');
    try {
      await libraryApi.issueBook({ bookId: id, studentId: issueStudent, dueDate: new Date(Date.now() + 14 * 86400000).toISOString() });
      await fetchBooks();
    } catch (err: any) { alert(err.detail || 'Failed to issue book'); }
    setShowIssue(null);
    setIssueStudent('');
    stopLoading();
  };

  const returnBook = async (id: string) => {
    startLoading('Processing return...');
    try {
      await libraryApi.returnBook(id);
      await fetchBooks();
    } catch (err: any) { alert(err.detail || 'Failed to return book'); }
    stopLoading();
  };

  const totalBooks = books.reduce((a, b) => a + Number(b.total), 0);
  const totalIssued = books.reduce((a, b) => a + Number(b.issued), 0);
  const categories = [...new Set(books.map(b => b.category))];

  return (
    <>
      <Topbar title="Library Management" subtitle="Book catalog, issue and return" />
      <div style={{ padding: '24px 32px' }}>
        <div className="grid grid-4 gap-4 mb-6">
          {[{ l: 'Total Books', v: String(totalBooks), c: '#5048E5' }, { l: 'Issued', v: String(totalIssued), c: '#F59E0B' }, { l: 'Available', v: String(totalBooks - totalIssued), c: '#10B981' }, { l: 'Categories', v: String(categories.length), c: '#3B82F6' }].map(s => (
            <div key={s.l} className="stat-card" style={{ borderLeftColor: s.c }}><div className="stat-icon" style={{ background: s.c + '15', color: s.c }}><span className="icon">local_library</span></div><div><div className="stat-value">{s.v}</div><div className="stat-label">{s.l}</div></div></div>
          ))}
        </div>

        <div className="flex items-center justify-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="flex gap-3"><div className="search-bar"><span className="icon">search</span><input placeholder="Search book or author..." value={search} onChange={e => setSearch(e.target.value)} /></div>
            <select className="select" style={{ width: 140 }} value={filterCat} onChange={e => setFilterCat(e.target.value)}><option value="All">All Categories</option>{categories.map(c => <option key={c}>{c}</option>)}</select>
          </div>
        </div>

        {user?.role !== 'STUDENT' && showIssue !== null && (
          <div className="card mb-4 animate-fadeIn"><div className="card-body">
            <h3 className="mb-4">Issue Book: {books.find(b => b.id === showIssue)?.title}</h3>
            <div className="grid grid-3 gap-4">
              <div className="input-group"><label className="input-label">Student ID</label><input className="input" value={issueStudent} onChange={e => setIssueStudent(e.target.value)} placeholder="Enter student ID" /></div>
              <div className="input-group"><label className="input-label">Issue Date</label><input className="input" type="date" defaultValue={new Date().toISOString().split('T')[0]} /></div>
              <div className="input-group"><label className="input-label">Return Date</label><input className="input" type="date" defaultValue={new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]} /></div>
            </div>
            <div className="flex gap-3 mt-4"><button className="btn btn-success" onClick={() => issueBook(showIssue)}><span className="icon icon-sm">check</span>Confirm Issue</button><button className="btn btn-secondary" onClick={() => setShowIssue(null)}>Cancel</button></div>
          </div></div>
        )}

        {error && (
          <div className="card mb-4" style={{ padding: 24, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12 }}>
            <div className="flex items-center gap-3">
              <span className="icon" style={{ color: '#EF4444' }}>error</span>
              <div><div style={{ fontWeight: 600, color: '#991B1B' }}>Connection Error</div><div style={{ fontSize: 14, color: '#B91C1C' }}>{error}</div></div>
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={fetchBooks}><span className="icon icon-sm">refresh</span>Retry</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="icon" style={{ fontSize: 32, color: '#5048E5', animation: 'spin 1s linear infinite' }}>progress_activity</span><p style={{ marginTop: 12, color: '#6B7280' }}>Loading books...</p></div>
        ) : !error && (
          <div className="grid grid-3 gap-4">
            {filtered.map(b => (
              <div key={b.id} className="card"><div className="card-body">
                <div className="flex items-center justify-between mb-2"><span className="badge badge-primary">{b.category}</span><span className={`badge ${b.available > 3 ? 'badge-success' : b.available > 0 ? 'badge-warning' : 'badge-danger'}`}>{b.available > 0 ? `${b.available} available` : 'All issued'}</span></div>
                <h4>{b.title}</h4><p className="text-sm text-gray mt-1">{b.author}</p><p className="text-xs text-gray mt-1">ISBN: {b.isbn}</p>
                <div className="flex justify-between items-center mt-3"><span className="text-xs text-gray">{b.issued}/{b.total} issued</span>
                  <div style={{ height: 6, flex: 1, background: 'var(--gray-100)', borderRadius: 3, margin: '0 12px' }}><div style={{ height: '100%', width: `${(b.issued / b.total) * 100}%`, borderRadius: 3, background: b.available <= 0 ? '#EF4444' : b.available <= 3 ? '#F59E0B' : '#10B981' }}></div></div>
                </div>
                <div className="flex gap-2 mt-3">
                  {user?.role === 'STUDENT' ? (
                    <span className="badge badge-primary"><span className="icon icon-sm">calendar_clock</span> Due: {new Date(b.dueDate).toLocaleDateString()}</span>
                  ) : (
                    <>
                      {b.available > 0 && <button className="btn btn-sm btn-primary" onClick={() => setShowIssue(b.id)}><span className="icon icon-sm">bookmark_add</span>Issue</button>}
                      {b.issued > 0 && <button className="btn btn-sm btn-secondary" onClick={() => returnBook(b.id)}><span className="icon icon-sm">bookmark_remove</span>Return</button>}
                    </>
                  )}
                </div>
              </div></div>
            ))}
            {filtered.length === 0 && <div className="card" style={{ gridColumn: 'span 3', padding: 24, textAlign: 'center', color: '#9CA3AF' }}>No books found</div>}
          </div>
        )}
      </div>
    </>
  );
}
