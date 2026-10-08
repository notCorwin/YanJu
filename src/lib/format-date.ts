export const formatDate = (value: number) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false })
